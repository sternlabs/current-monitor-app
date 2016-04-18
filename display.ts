/// <reference path="typings/browser.d.ts" />

namespace Display {

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

    constructor(element: HTMLElement) {
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        this.renderer = new THREE.WebGLRenderer();
        this.renderer.setSize( window.innerWidth * 0.9, window.innerHeight * 0.9);
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

    async setupGrid() {
        var material = await this.mkShaderMaterial({
            vertexShader: 'vert.glsl' ,
            fragmentShader: 'frag.glsl',
        });

        let ybounds = [-1e-6, 0.3];

        material.setValues({uniforms: {
            alpha: {type: "f", value: 1e-5},
            ybounds: {type: "v2", value: new THREE.Vector2(ybounds[0], ybounds[1])},
            color: {type: "v4", value: new THREE.Vector4(0.3, 0.3, 0.3, 0.3)}
        }});

        var geometry = new THREE.Geometry();
        var xbreaks = [-0.5, 0, 0.5];
        var ybreaks = [-1e-6, 0, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 3e-1];

        for (let x of xbreaks) {
            geometry.vertices.push(new THREE.Vector3(x, ybounds[0], 0));
            geometry.vertices.push(new THREE.Vector3(x, ybounds[1], 0));
        }

        for (let y of ybreaks) {
            geometry.vertices.push(new THREE.Vector3(-1, y, 0));
            geometry.vertices.push(new THREE.Vector3(1, y, 0));
        }

        var line = new THREE.LineSegments(geometry, material);
        this.scene.add(line);
    }

    render() {
	this.renderer.render(this.scene, this.camera);
    }
}


async function main() {
    let d = new Display(document.getElementById("glbox"));
    await d.setupGrid();
    d.render();
}

main();
}
