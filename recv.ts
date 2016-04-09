import usb = require('usb');

function log(...vals: any[]) {
    var logelem = document.getElementById("log");

    logelem.innerText += vals.join(" ") + "\n";
}

enum CM_REQ {
    GET_BUFSIZE = 0,
    SET_DAC = 1,
    SET_RELAY = 2,
    SET_VOLTAGE = 3,
    SET_CURRENT = 4,
};

var opts = {
    dac: 2048
};

log("Initializing");

var device = usb.findByIds(0x2323, 0x8000);
log("device", device);
device.open();
var iface = device.interface(0);
iface.claim();
var ep = iface.endpoint(0x81);

ep.on("data", recvData);
ep.on("error", function(error: any) {throw error;});

function cm_req(req: CM_REQ, val: number, cb?: ()=>void) {
    device.controlTransfer(0x21, req, val, 0, new Buffer(0), function(error: any, data: Buffer) {
        if (error)
            throw error;
        if (cb)
            cb();
    });
}

function setDac(val: number, cb?: ()=>void) {
    log("setting dac to", val, "...");
    cm_req(CM_REQ.SET_DAC, val, function(){
        log("dac set to", val);
        if (cb)
            cb();
    });
}

function setRelay(val: number, cb?: ()=>void) {
    log("setting relay to", val, "...");
    cm_req(CM_REQ.SET_RELAY, val, function(){
        log("relay set to", val);
        if (cb)
            cb();
    });
}

function setVoltage(val: number, cb?: ()=>void) {
    log("setting voltage to", val, "...");
    cm_req(CM_REQ.SET_VOLTAGE, val, function(){
        log("voltage set to", val);
        if (cb)
            cb();
    });
}

function setCurrent(val: number, cb?: ()=>void) {
    log("setting current to", val, "...");
    cm_req(CM_REQ.SET_CURRENT, val, function(){
        log("current set to", val);
        if (cb)
            cb();
    });
}

async function setState(state: stateInfo) {
    let curstate = lastblock.state;

    let all: Promise<void>[] = [];
    if (state.relay != curstate.relay) {
        all.push(new Promise<void>(resolve => setRelay(state.relay, resolve)));
    }
    if (state.dac != curstate.dac) {
        all.push(new Promise<void>(resolve => setDac(state.dac, resolve)));
    }
    if (state.current != curstate.current) {
        all.push(new Promise<void>(resolve => setCurrent(state.current, resolve)));
    }
    if (state.voltage != curstate.voltage) {
        all.push(new Promise<void>(resolve => setVoltage(state.voltage, resolve)));
    }
    return Promise.all(all);
}


function startStreamData() {
    log("starting streaming");
    ep.startPoll(16, blocksize);
}


log("Reading blocksize...");
var blocksize: number;
device.controlTransfer(0xa1, 0, 0, 0, 2, function(error: any, data: Buffer) {
    if (error)
        throw error;
    blocksize = data.readUInt16LE(0);
    log("blocksize", blocksize);

    startStreamData();
});

var onBlock: (block: blockInfo) => void;

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
    dac: number;
    relay: calibrateRelay;
    voltage: calibrateVoltage;
    current: calibrateCurrent;
}

interface blockInfo {
    state: stateInfo;
    voltage: number;
    coarse: number[];
    fine: number[];
}

var lastblock: blockInfo;
var haveRedraw = false;

function recvData(data: Buffer) {
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
    if (!haveRedraw) {
        window.requestAnimationFrame(draw);
        haveRedraw = true;
    }

    lastblock = block;

    if (onBlock)
        onBlock(block);
}

// calibrate:
// - offset
// - CMRR
// - gain

function mean(ary: number[]) {
    return ary.reduce(function(a,b){return a+b;})/ary.length;
}

async function waitForBlock() {
    return new Promise<blockInfo>(resolve => {
        onBlock = resolve;
    });
}

async function configAndWait(newState: stateInfo) {
    await setState(newState);

    let block = lastblock;

    while (block.state.dac !== newState.dac ||
           block.state.relay !== newState.relay ||
           block.state.voltage !== newState.voltage ||
           block.state.current !== newState.current) {
        block = await waitForBlock();
    }
    // let's take the next one
    return waitForBlock();
}

interface cmCalibration {
    dac: number;
    voltageOff: number;
    voltageGain: number;
    coarseOff: number;
    coarseGain: number;
    fineOff: number;
    fineGain: number;
    fineCmrrGain: number;
}

async function calibrate() {
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
    let block = await configAndWait({dac: dac, relay: calibrateRelay.CALIBRATE, voltage: calibrateVoltage.OFF, current: calibrateCurrent.A30m});
    let voltageOff = block.voltage;
    let coarseOff = mean(block.coarse);
    let fineOff = mean(block.fine);

    log("voltage offset", voltageOff);
    log("coarse offset", coarseOff);

    while (fineOff < 20 || fineOff > 40) {
        if (fineOff > 40)
            dac = nextDac("up");
        else
            dac = nextDac("down");

        log("fine offset", fineOff, "out of range, adjusting dac to", dac);

        block = await configAndWait({dac: dac, relay: calibrateRelay.CALIBRATE, voltage: calibrateVoltage.OFF, current: calibrateCurrent.A300u});
        fineOff = mean(block.fine);
    }
    log("fine offset", fineOff);

    // determine CMRR
    block = await configAndWait({dac: dac, relay: calibrateRelay.CALIBRATE, voltage: calibrateVoltage.V3, current: calibrateCurrent.OFF});
    let voltageGain = 3.0 / (block.voltage - voltageOff);
    let fineOff3V = mean(block.fine) - fineOff;
    let fineCmrrGain = fineOff3V / 3.0;

    log("cmrr offset at 3V", fineOff3V, "cmrr gain", fineCmrrGain, "voltage gain", voltageGain);

    // fine range gain
    block = await configAndWait({dac: dac, relay: calibrateRelay.CALIBRATE, voltage: calibrateVoltage.V3, current: calibrateCurrent.A300u});
    let voltage300uA = (block.voltage - voltageOff) * voltageGain;
    let current300uA = voltage300uA / (3*470e3);
    let fineVal300uA = mean(block.fine) - fineCmrrGain * voltage300uA;
    let fineGain = current300uA / fineVal300uA;

    log("fine gain", fineGain, "at V =", voltage300uA, "I =", current300uA);
}

function draw(timestamp: number) {
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

    coarse.textContent = mean(lastblock.coarse).toString();
    fine.textContent = mean(lastblock.fine).toString();
    voltage.textContent = lastblock.voltage.toString();

    haveRedraw = false;
}

document.getElementById("dac").onchange = function() {
    var dac = <HTMLInputElement>document.getElementById("dac");
    setDac(parseInt(dac.value));
    return false;
};

document.getElementById("relay").onchange = function() {
    var val = (<HTMLSelectElement>document.getElementById("relay")).value;
    setRelay(+val);
}

document.getElementById("voltage").onchange = function() {
    var val = (<HTMLSelectElement>document.getElementById("voltage")).value;
    setVoltage(+val);
}

document.getElementById("current1").onchange = function() {
    var val = 0;
    for (let v = 1; v <= 4; ++v) {
        let name = "current"+v;
        let el = <HTMLInputElement>document.getElementById(name);
        if (el.checked)
            val += +el.value;
    }

    setCurrent(val);
}
document.getElementById("current2").onchange = document.getElementById("current1").onchange;
document.getElementById("current3").onchange = document.getElementById("current1").onchange;
document.getElementById("current4").onchange = document.getElementById("current1").onchange;

document.getElementById("calibrate").onclick = calibrate;
