import {CmUsb, blockInfo, rawBlockInfo, stateInfo} from "./device";
import {mean} from "./util";
import {SampleBuffer} from "./buffer";

function log(...vals: any[]) {
    var logelem = document.getElementById("log");

    logelem.innerText += vals.join(" ") + "\n";
}


interface ShaderLocation {
    [name: string]: string;
};

interface ShaderText {
    [name: string]: string;
};


class Display {
    scene: THREE.Scene;
    camera: THREE.Camera;
    renderer: THREE.Renderer;
    material: THREE.ShaderMaterial;
    ybounds: number[];

    grid: THREE.Object3D;
    data: THREE.Line;

    constructor(element: HTMLElement) {
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        this.renderer = new THREE.WebGLRenderer();
        this.renderer.setSize( window.innerWidth * 0.5, window.innerHeight * 0.5);
        element.appendChild(this.renderer.domElement);
    }

    async mkShaderMaterial(shaders: ShaderLocation) {
        var loader = new THREE.XHRLoader();

        let all: Promise<string>[] = [];
        for (let name in shaders) {
            all.push(new Promise((resolve, fail) => loader.load(shaders[name], resolve, null, fail)));
        }

        let texts = await Promise.all(all);

        let params: ShaderText = {};
        for (let name in shaders) {
            params[name] = texts.shift();
        }

        return new THREE.ShaderMaterial(params);
    }

    async setup() {
        await this.setupShaders();
        this.setupGrid();
        this.setupData();
    }

    async setupShaders() {
        this.material = await this.mkShaderMaterial({
            vertexShader: 'vert.glsl' ,
            fragmentShader: 'frag.glsl',
        });

        this.ybounds = [-1e-6, 0.3];

        this.material.setValues({uniforms: {
            alpha: {type: "f", value: 1e-5},
            ybounds: {type: "v2", value: new THREE.Vector2(this.ybounds[0], this.ybounds[1])},
        }});
    }

    setupGrid() {
        let material = this.material.clone();
        material.uniforms.color = {type: "v4", value: new THREE.Vector4(0.3, 0.3, 0.3, 0.3)};

        var geometry = new THREE.Geometry();
        var xbreaks = [-0.5, 0, 0.5];
        var ybreaks = [-1e-6, 0, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 3e-1];

        for (let x of xbreaks) {
            geometry.vertices.push(new THREE.Vector3(x, this.ybounds[0], 0));
            geometry.vertices.push(new THREE.Vector3(x, this.ybounds[1], 0));
        }

        for (let y of ybreaks) {
            geometry.vertices.push(new THREE.Vector3(-1, y, 0));
            geometry.vertices.push(new THREE.Vector3(1, y, 0));
        }

        this.grid = new THREE.LineSegments(geometry, material);
        this.scene.add(this.grid);
    }

    setupData() {
        let material = this.material.clone();
        material.uniforms.color = {type: "v4", value: new THREE.Vector4(1.0, 1.0, 0.0, 1.0)};

        var geometry = new THREE.Geometry();
        this.data = new THREE.Line(geometry, material);
        this.scene.add(this.data);
    }

    drawData(values: ArrayLike<number>) {
        let num = values.length;
        let geo = <THREE.Geometry>(this.data.geometry);
        if (num < geo.vertices.length) {
            geo = new THREE.Geometry();
            this.data.geometry.dispose();
            this.data.geometry = geo;
            // this.scene.remove(this.data);
            // this.data = new THREE.LineSegments(geo, <THREE.ShaderMaterial>(this.data.material));
            // this.scene.add(this.data);
        }
        for (let idx = 0; idx < num; idx++) {
            geo.vertices[idx] = new THREE.Vector3(idx/(num-1)*2 - 1, values[idx], 0.0);
        }
        for (let idx = num; idx < geo.vertices.length; idx++) {
            geo.vertices[idx].x = 10;
        }
        geo.verticesNeedUpdate = true;
    }

    render() {
	this.renderer.render(this.scene, this.camera);
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
        var voltageEl = <HTMLSpanElement>document.getElementById("voltage");
        var currentEl = <HTMLSpanElement>document.getElementById("current");

        voltageEl.textContent = this.lastblock.voltage.toFixed(2);
        currentEl.textContent = mean(this.lastblock.current).toPrecision(4);
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

        this.dac = <HTMLInputElement>document.getElementById("cal-dac");
        this.relay = <HTMLSelectElement>document.getElementById("cal-relay");
        this.voltage = <HTMLSelectElement>document.getElementById("cal-voltage");

        this.dac.onchange = () => {
            dev.setState({dac: +this.dac.value});
            return false;
        }

        this.relay.onchange = () => this.dev.setState({relay: +this.relay.value});
        this.voltage.onchange = () => this.dev.setState({voltage: +this.voltage.value});
        for (let v = 1; v <= 4; ++v) {
            this.current[v] = <HTMLInputElement>document.getElementById("cal-current"+v);
            this.current[v].onchange = this.setCurrent.bind(this);
        }

        document.getElementById("calibrate").onclick = () => {
            dev.calibrate.calibrate();
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

    let d = new Display(document.getElementById("glbox"));
    await d.setup();

    let samples = new SampleBuffer(240000);

    let haveRedraw = false;
    dev.on('block', (block: blockInfo) => {
        if (haveRedraw)
            return;

        samples.store(block.current);

        let s = samples.getByTime(-1, 1);

        let target = 2000;
        let reduced: number[] = [];
        let ratio = s.length / target;
        if (ratio < 1) {
            ratio = 1;
        }
        for (let pos = 0; Math.ceil(pos) < s.length; pos += ratio) {
            reduced.push(mean(s.subarray(pos, (pos+ratio)|0)));
        }

        d.drawData(reduced);
        haveRedraw = true;
        window.requestAnimationFrame(() => {
            haveRedraw = false;
            d.render();
        });
    });
}

main();
