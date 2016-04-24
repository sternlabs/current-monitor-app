import usb = require('usb');
import {EventEmitter} from 'events';
import {mean} from "./util";

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

export interface stateInfo {
    dac?: number;
    relay?: calibrateRelay;
    voltage?: calibrateVoltage;
    current?: calibrateCurrent;
}

export interface rawBlockInfo {
    state: stateInfo;
    voltage: number;
    coarse: number[];
    fine: number[];
}

export interface blockInfo {
    voltage: number;
    current: number[];
}


export class CmUsb extends EventEmitter {
    device: any;
    iface: any;
    ep: any;
    blocksize: number;

    lastblock: rawBlockInfo;

    calibrate: Calibrate;

    constructor() {
        super()

        this.device = usb.findByIds(0x2323, 0x8000);
        console.log("device", this.device);
        this.device.open();
        this.iface = this.device.interface(0);
        this.iface.claim();
        this.ep = this.iface.endpoint(0x81);

        this.ep.on("data", (data: Buffer) => this.recvData(data));
        this.ep.on("error", function(error: any) {throw error;});

        this.calibrate = new Calibrate(this);
    }

    async init() {
        let data = await this.request(CM_REQ.GET_BUFSIZE, 0, 2);
        this.blocksize = data.readUInt16LE(0);
        console.log("blocksize", this.blocksize);
        console.log("starting streaming");
        this.ep.startPoll(16, this.blocksize);
    }

    async request(req: CM_REQ, val: number, receive?: number) {
        let usbReq = receive ? 0xa1 : 0x21;
        if (receive == null)
            console.log("setting", CM_REQ[req], "to", val);
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
            all.push(new Promise(resolve => setTimeout(resolve, 50)));
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

        var block: rawBlockInfo = {
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

        for (var i = 6; i <= data.length - 3;) {
            var val = data.readUInt8(i++);
            val = val | (data.readUInt8(i++) << 8);
            val = val | (data.readUInt8(i++) << 16);
            var coarse = val & 0xfff;
            var fine = val >> 12;
            block.coarse.push(coarse);
            block.fine.push(fine);
        }

        this.lastblock = block;
        this.emit("rawblock", block);

        let convBlock = this.calibrate.convert(block);
        this.emit('block', convBlock);
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
        return new Promise<rawBlockInfo>(resolve => this.dev.once('rawblock', resolve));
    }

    async configAndWait(newState: stateInfo) {
        await this.dev.setState(newState);

        let block: rawBlockInfo;

        do {
            block = await this.waitForBlock();
        } while (newState.dac != null && block.state.dac !== newState.dac ||
                 newState.relay != null && block.state.relay !== newState.relay ||
                 newState.voltage != null && block.state.voltage !== newState.voltage ||
                 newState.current != null && block.state.current !== newState.current) {
        }
        return await this.waitForBlock();
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

        console.log("voltage offset", newCalib.voltageOff);
        console.log("coarse offset", newCalib.coarseOff);

        while (newCalib.fineOff < 20 || newCalib.fineOff > 40) {
            if (newCalib.fineOff > 40) {
                dac = nextDac("up");
            } else {
                dac = nextDac("down");
                // Any time we saturate the amp on the negative side,
                // we need to saturate it on the positive side to establish
                // a consistent offset hysteresis.
                await this.configAndWait({dac: dac, voltage: calibrateVoltage.V5});
            }

            if (dacRange[0] == dacRange[1] ||
                dacRange[0] + 1 == dacRange[1]) {
                console.log("error during dac calibration, retrying");
                return this.calibrate();
            }

            console.log("fine offset", newCalib.fineOff, "out of range, adjusting dac to", dac);

            block = await this.configAndWait({dac: dac, voltage: calibrateVoltage.OFF});
            newCalib.fineOff = mean(block.fine);
        }
        newCalib.dac = dac;
        // long integrate
        let coarsemeans: number[] = []
        let finemeans: number[] = [];
        for (let i = 0; i < 10; ++i) {
            coarsemeans.push(mean(block.coarse));
            finemeans.push(mean(block.fine));
            block = await this.waitForBlock();
        }
        do {
            coarsemeans.push(mean(block.coarse));
            finemeans.push(mean(block.fine));
            block = await this.waitForBlock();
        } while (Math.abs(mean(finemeans.concat([mean(block.fine)]))/mean(finemeans)-1) > 0.0001);

        newCalib.fineOff = mean(finemeans);
        newCalib.coarseOff = mean(coarsemeans);

        console.log("averaging", finemeans.length, "blocks", finemeans);
        console.log("averaged coarse offset", newCalib.coarseOff);
        console.log("averaged fine offset", newCalib.fineOff);

        // determine CMRR
        block = await this.configAndWait({voltage: calibrateVoltage.V3, current: calibrateCurrent.OFF});
        let voltage3Vraw = block.voltage - newCalib.voltageOff;
        newCalib.voltageGain = 3.0 / voltage3Vraw;
        let fineOff3V = mean(block.fine) - newCalib.fineOff;
        newCalib.fineCmrrGain = fineOff3V / voltage3Vraw;

        console.log("cmrr offset at 3V", fineOff3V, "cmrr gain", newCalib.fineCmrrGain, "voltage gain", newCalib.voltageGain);

        // fine range gain
        block = await this.configAndWait({voltage: calibrateVoltage.V3, current: calibrateCurrent.A300u});
        let voltage300uAraw = block.voltage - newCalib.voltageOff;
        let voltage300uA = voltage300uAraw * newCalib.voltageGain;
        let current300uA = voltage300uA / 15e3;
        let fineVal300uA = mean(block.fine) - newCalib.fineOff - newCalib.fineCmrrGain * voltage300uAraw;
        newCalib.fineGain = current300uA / fineVal300uA;

        console.log("fine gain", newCalib.fineGain, "at V =", voltage300uA, "I =", current300uA);

        // coarse range gain
        block = await this.configAndWait({voltage: calibrateVoltage.V5, current: calibrateCurrent.A30m});
        let voltage5V30m = (block.voltage - newCalib.voltageOff) * newCalib.voltageGain;
        let current30m = voltage5V30m / 150.0;
        let coarseVal30m = mean(block.coarse) - newCalib.coarseOff;
        newCalib.coarseGain = current30m / coarseVal30m;

        console.log("coarse gain", newCalib.coarseGain, "at V =", voltage5V30m, "I =", current30m);

        this.calibration = newCalib;
    }

    convert(raw: rawBlockInfo): blockInfo {
        let correctedVoltage = raw.voltage - this.calibration.voltageOff;
        let tVoltage = correctedVoltage * this.calibration.voltageGain;
        let tCurrent: number[] = [];

        for (let i = 0; i < raw.fine.length; i++) {
            let current = (raw.fine[i] - this.calibration.fineOff - correctedVoltage * this.calibration.fineCmrrGain) * this.calibration.fineGain;

            if (raw.fine[i] > 4075) {
                current = (raw.coarse[i] - this.calibration.coarseOff) * this.calibration.coarseGain;
            }
            tCurrent.push(current);
        }

        return {voltage: tVoltage, current: tCurrent}
    }
}
