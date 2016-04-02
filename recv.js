var log = document.getElementById("log");
var plot = document.getElementById("plot");
var plotCtx = plot.getContext("2d");

log.innerText = "foo\n";

var usb = require('usb');
var process = require('process');

var opts = {
    dac: 2048
};

var device = usb.findByIds(0x2323, 0x8000);
device.open();
var iface = device.interface(0);
iface.claim();
var ep = iface.endpoint(0x81);

ep.on("data", recvData);
ep.on("error", function(error) {throw error;});

var blocksize;
device.controlTransfer(0xa1, 0, 0, 0, 2, function(error, data) {
    if (error)
        throw error;
    blocksize = data.readUInt16LE(0);
    setDac(opts.dac, function() {
        startStreamData();
    });
});

function setDac(val, cb) {
    device.controlTransfer(0x21, 1, val, 0, new Buffer(0), function(error, data) {
        if (error)
            throw error;
        if (cb)
            cb();
    });
}

function startStreamData() {
    ep.startPoll(16, blocksize);
}

var lastcoarse;
var lastfine;
var lastvolt;
var haveRedraw = false;

function recvData(data) {
    var voltage = data.readUInt16LE(0);
    var flags = data.readUInt16LE(1);

    lastvolt = voltage;
    lastcoarse = [];
    lastfine = [];

    for (var i = 4; i < data.length - 3;) {
        var val = data.readUInt8(i++);
        val = val | (data.readUInt8(i++) << 8);
        val = val | (data.readUInt8(i++) << 16);
        var coarse = val & 0xfff;
        var fine = val >> 12;
        lastcoarse.push(coarse);
        lastfine.push(fine);
    }
    if (!haveRedraw) {
        window.requestAnimationFrame(draw);
        haveRedraw = true;
    }
}

function draw(timestamp) {
    var pixel = plotCtx.createImageData(1, 1);
    pixel.data[0] = 255;
    pixel.data[3] = 255;

    var xmax = 1024;
    var ymax = 512;
    plot.width = plot.width;

    for (var x = 0; x < 1024; x++) {
        var val = lastfine[x] >> 3;
        var y = ymax - 1 - val;
        plotCtx.putImageData(pixel, x, y);
    }

    haveRedraw = false;
}

var dacForm = document.getElementById("setDac");
dacForm.onsubmit = function() {
    var dac = document.getElementById("dac");
    setDac(parseInt(dac.value));
    return false;
};
