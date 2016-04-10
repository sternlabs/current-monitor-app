function log(...vals: any[]) {
    var logelem = document.getElementById("log");

    logelem.innerText += vals.join(" ") + "\n";
}

function mean(ary: number[]) {
    return ary.reduce(function(a,b){return a+b;})/ary.length;
}


import usb = require('usb');
import {EventEmitter} from 'events';

enum CM_REQ {
    GET_BUFSIZE = 0,
    SET_DAC = 1,
    SET_RELAY = 2,
    SET_VOLTAGE = 3,
    SET_CURRENT = 4,
};

enum calibrateRelay {
    NORMAL,
    INOUT_SHORT,
    CALIBRATE
}

enum calibrateVoltage {
    OFF,
    V5,
    V3
}

enum calibrateCurrent {
    OFF,
    A3u = 1,
    A300u = 2,
    A30m = 4,
    A30m_2 = 8
}

interface stateInfo {
    dac?: number;
    relay?: calibrateRelay;
    voltage?: calibrateVoltage;
    current?: calibrateCurrent;
}

interface blockInfo {
    state: stateInfo;
    voltage: number;
    coarse: number[];
    fine: number[];
}


class CmUsb extends EventEmitter {
    device: any;
    iface: any;
    ep: any;
    blocksize: number;

    lastblock: blockInfo;

    constructor() {
        super()

        this.device = usb.findByIds(0x2323, 0x8000);
        log("device", this.device);
        this.device.open();
        this.iface = this.device.interface(0);
        this.iface.claim();
        this.ep = this.iface.endpoint(0x81);

        this.ep.on("data", (data: Buffer) => this.recvData(data));
        this.ep.on("error", function(error: any) {throw error;});
    }

    async init() {
        let data = await this.request(CM_REQ.GET_BUFSIZE, 0, 2);
        this.blocksize = data.readUInt16LE(0);
        log("blocksize", this.blocksize);
        log("starting streaming");
        this.ep.startPoll(16, this.blocksize);
    }

    async request(req: CM_REQ, val: number, receive?: number) {
        let usbReq = receive ? 0xa1 : 0x21;
        if (receive == null)
            log("setting", CM_REQ[req], "to", val);
        return new Promise<Buffer>(
            (resolve, reject) => this.device.controlTransfer(usbReq, req, val, 0, receive != null ? receive : new Buffer(0), function(error: any, value: Buffer) {
                if (error)
                    reject(error);
                else
                    resolve(value);
            }));
    }

    async setState(state: stateInfo) {
        let curstate = this.lastblock.state;

        let all: Promise<Buffer>[] = [];
        if (state.relay != null && state.relay != curstate.relay) {
            all.push(this.request(CM_REQ.SET_RELAY, state.relay));
        }
        if (state.dac != null && state.dac != curstate.dac) {
            all.push(this.request(CM_REQ.SET_DAC, state.dac));
        }
        if (state.current != null && state.current != curstate.current) {
            all.push(this.request(CM_REQ.SET_CURRENT, state.current));
        }
        if (state.voltage != null && state.voltage != curstate.voltage) {
            all.push(this.request(CM_REQ.SET_VOLTAGE, state.voltage));
        }
        await Promise.all(all);
        this.emit('state', state);
    }

    recvData(data: Buffer) {
        var voltage = data.readUInt16LE(0);
        var state = data.readUInt32LE(2);

        var block: blockInfo = {
            state: {
                dac: state & 0xfff,
                relay: (state >> 12) & 3,
                voltage: (state >> 14) & 3,
                current: (state >> 16) & 0xf,
            },
            voltage: voltage,
            coarse: [],
            fine: [],
        };

        for (var i = 6; i < data.length - 3;) {
            var val = data.readUInt8(i++);
            val = val | (data.readUInt8(i++) << 8);
            val = val | (data.readUInt8(i++) << 16);
            var coarse = val & 0xfff;
            var fine = val >> 12;
            block.coarse.push(coarse);
            block.fine.push(fine);
        }

        this.lastblock = block;
        this.emit("block", block);
    }
}


class cmCalibration {
    dac: number;
    voltageOff: number;
    voltageGain: number;
    coarseOff: number;
    coarseGain: number;
    fineOff: number;
    fineGain: number;
    fineCmrrGain: number;

    constructor() {
        this.dac = 0;
        this.voltageOff = 0;
        this.voltageGain = 1;
        this.coarseOff = 0;
        this.coarseGain = 1;
        this.fineOff = 0;
        this.fineGain = 1;
        this.fineCmrrGain = 0;
    }
}

class Calibrate {
    dev: CmUsb;
    calibration: cmCalibration = new cmCalibration();

    constructor(dev: CmUsb) {
        this.dev = dev;
    }

    async waitForBlock() {
        return new Promise<blockInfo>(resolve => this.dev.once('block', resolve));
    }

    async configAndWait(newState: stateInfo) {
        await this.dev.setState(newState);

        let block: blockInfo;

        do {
            block = await this.waitForBlock();
        } while (newState.dac != null && block.state.dac !== newState.dac ||
                 newState.relay != null && block.state.relay !== newState.relay ||
                 newState.voltage != null && block.state.voltage !== newState.voltage ||
                 newState.current != null && block.state.current !== newState.current) {
        }
        return block;
    }

    async calibrate(): Promise<void> {
        let newCalib = new cmCalibration();

        // calibrate offset
        let dacRange = [0, 0xfff];
        function nextDac(direction: "up" | "down") {
            let prev = ~~mean(dacRange); // ~~ truncates to integer
            if (direction == "up") {
                dacRange = [prev, dacRange[1]];
            } else {
                dacRange = [dacRange[0], prev];
            }
            return ~~mean(dacRange);
        }

        let dac = ~~mean(dacRange);
        let block = await this.configAndWait({dac: dac, relay: calibrateRelay.CALIBRATE, voltage: calibrateVoltage.OFF, current: calibrateCurrent.A30m});
        newCalib.voltageOff = block.voltage;
        newCalib.coarseOff = mean(block.coarse);
        newCalib.fineOff = mean(block.fine);

        log("voltage offset", newCalib.voltageOff);
        log("coarse offset", newCalib.coarseOff);

        while (newCalib.fineOff < 20 || newCalib.fineOff > 40) {
            if (newCalib.fineOff > 40)
                dac = nextDac("up");
            else
                dac = nextDac("down");

            if (dacRange[0] == dacRange[1]) {
                log("error during dac calibration, retrying");
                return this.calibrate();
            }

            log("fine offset", newCalib.fineOff, "out of range, adjusting dac to", dac);

            block = await this.configAndWait({dac: dac});
            newCalib.fineOff = mean(block.fine);
        }
        newCalib.dac = dac;
        log("fine offset", newCalib.fineOff);

        // determine CMRR
        block = await this.configAndWait({voltage: calibrateVoltage.V3, current: calibrateCurrent.OFF});
        newCalib.voltageGain = 3.0 / (block.voltage - newCalib.voltageOff);
        let fineOff3V = mean(block.fine) - newCalib.fineOff;
        newCalib.fineCmrrGain = fineOff3V / 3.0;

        log("cmrr offset at 3V", fineOff3V, "cmrr gain", newCalib.fineCmrrGain, "voltage gain", newCalib.voltageGain);

        // fine range gain
        block = await this.configAndWait({voltage: calibrateVoltage.V3, current: calibrateCurrent.A300u});
        let voltage300uA = this.translateVoltage(block.voltage);
        let current300uA = voltage300uA / (3*470e3);
        let fineVal300uA = mean(block.fine) - newCalib.fineOff - newCalib.fineCmrrGain * voltage300uA;
        newCalib.fineGain = current300uA / fineVal300uA;

        log("fine gain", newCalib.fineGain, "at V =", voltage300uA, "I =", current300uA);

        // coarse range gain
        block = await this.configAndWait({voltage: calibrateVoltage.V5, current: calibrateCurrent.A30m});
        let voltage5V30m = this.translateVoltage(block.voltage);
        let current30m = voltage5V30m / 150.0;
        let coarseVal30m = mean(block.coarse) - newCalib.coarseOff;
        newCalib.coarseGain = current30m / coarseVal30m;

        log("coarse gain", newCalib.coarseGain, "at V =", voltage5V30m, "I =", current30m);

        this.calibration = newCalib;
    }

    translateVoltage(voltage: number): number {
        return voltage - this.calibration.voltageOff * this.calibration.voltageGain;
    }

    translateCoarse(voltage: number, coarse: number | number[]): number | number[] {
        return this.translateAry(voltage, coarse, (ary: number[]) => {
            var tvals: number[];
            for (let v of ary) {
                tvals.push((v - this.calibration.coarseOff) * this.calibration.coarseGain);
            }
            return tvals;
        })
    }

    translateFine(voltage: number, fine: number | number[]): number | number[] {
        return this.translateAry(voltage, fine, (ary: number[]) => {
            var tvals: number[];
            for (let v of ary) {
                tvals.push((v - this.calibration.fineOff) * this.calibration.fineGain - voltage * this.calibration.fineCmrrGain);
            }
            return tvals;
        })
    }

    translateAry(voltage: number, vals_: number | number[], f: (v: number[]) => number[]): number | number[] {
        let tvoltage = voltage - this.calibration.voltageOff;

        let vals: number[];
        if (vals_ instanceof Array) {
            vals = vals_;
        } else {
            vals = [vals_];
        }

        let tvals = f(vals);

        if (vals_ instanceof Array) {
            return tvals;
        } else {
            return tvals[0];
        }
    }
}



class Draw {
    dev: CmUsb;
    haveRedraw: boolean;
    lastblock: blockInfo;

    constructor(dev: CmUsb) {
        this.dev = dev;
        this.dev.on('block', this.onBlock.bind(this));
    }

    onBlock(block: blockInfo) {
        this.lastblock = block;
        if (!this.haveRedraw) {
            window.requestAnimationFrame(this.draw.bind(this));
            this.haveRedraw = true;
        }
    }

    draw(timestamp: number) {
        // var pixel = plotCtx.createImageData(1, 1);
        // pixel.data[0] = 255;
        // pixel.data[3] = 255;

        // var xmax = 1024;
        // var ymax = 512;
        // plot.width = plot.width;

        // for (var x = 0; x < 1024; x++) {
        //     var val = lastfine[x] >> 3;
        //     var y = ymax - 1 - val;
        //     plotCtx.putImageData(pixel, x, y);
        // }

        var coarse = <HTMLSpanElement>document.getElementById("coarseval");
        var fine = <HTMLSpanElement>document.getElementById("fineval");
        var voltage = <HTMLSpanElement>document.getElementById("voltageval");

        coarse.textContent = mean(this.lastblock.coarse).toString();
        fine.textContent = mean(this.lastblock.fine).toString();
        voltage.textContent = this.lastblock.voltage.toString();

        this.haveRedraw = false;
    }
}

class Ui {
    dev: CmUsb;
    dac: HTMLInputElement;
    relay: HTMLSelectElement;
    voltage: HTMLSelectElement;
    current: HTMLInputElement[] = [];

    constructor(dev: CmUsb) {
        this.dev = dev;

        this.dev.on('state', this.onState.bind(this));

        this.dac = <HTMLInputElement>document.getElementById("dac");
        this.relay = <HTMLSelectElement>document.getElementById("relay");
        this.voltage = <HTMLSelectElement>document.getElementById("voltage");

        this.dac.onchange = () => {
            dev.setState({dac: +this.dac.value});
            return false;
        }

        this.relay.onchange = () => this.dev.setState({relay: +this.relay.value});
        this.voltage.onchange = () => this.dev.setState({voltage: +this.voltage.value});
        for (let v = 1; v <= 4; ++v) {
            this.current[v] = <HTMLInputElement>document.getElementById("current"+v);
            this.current[v].onchange = this.setCurrent.bind(this);
        }

        document.getElementById("calibrate").onclick = () => {
            let calib = new Calibrate(this.dev);
            calib.calibrate();
        }
    }

    setCurrent() {
        var val = 0;
        for (let v = 1; v <= 4; ++v) {
            let el = this.current[v]
            if (el.checked)
                val += +el.value;
        }

        this.dev.setState({current: val});
    }

    onState(state: stateInfo) {
        if (state.dac != null) {
            this.dac.value = state.dac+"";
        }
        if (state.relay != null) {
            this.relay.value = state.relay+"";
        }
        if (state.voltage != null) {
            this.voltage.value = state.voltage+"";
        }
        if (state.current != null) {
            for (let v = 1; v <= 4; ++v) {
                let set = (state.current & (1 << (v - 1))) != 0;
                this.current[v].checked = set;
            }
        }
    }
}

async function main() {
    let dev = new CmUsb();
    let draw = new Draw(dev);
    let ui = new Ui(dev);

    await dev.init();
}

main();
