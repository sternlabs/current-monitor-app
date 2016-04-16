/// <reference path="typings/browser.d.ts" />

interface ShaderLocation {
    [name: string]: string;
};

interface ShaderText {
    [name: string]: string;
};

function loadShaders(shaders: ShaderLocation, done: (shaders: ShaderText) => void) {
    var loader = new THREE.XHRLoader();
    var result: ShaderText = {};

    function notifyDone() {
        if (Object.keys(result).length == Object.keys(shaders).length) {
            done(result);
        }
    }

    for (let name in shaders) {
        ((name: string)=> {
            loader.load(shaders[name], function(text) {
                result[name] = text;
                notifyDone();
            }, null, function(evt) {
                console.log("error loading", shaders[name], ":", evt);
                result[name] = null;
                notifyDone();
            })
        })(name)
    }
}


loadShaders({
    frag: "frag.glsl",
    vert: "vert.glsl",
}, setupScene);

function setupScene(shaders: ShaderText) {
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 1000 );

    var renderer = new THREE.WebGLRenderer();
    renderer.setSize( window.innerWidth, window.innerHeight );
    document.body.appendChild( renderer.domElement );

    var geometry = new THREE.Geometry();

    var range = 0.4;
    var step = 1.0/window.innerWidth;
    var freq = 10;
    for (var x = -range/2; x < range/2; x += step) {
        var y = Math.sin(x*Math.PI*freq)*0.3;
        geometry.vertices.push(new THREE.Vector3(x, y, 0));
    }

    var material = new THREE.ShaderMaterial({
        vertexShader: shaders['vert'],
        fragmentShader: shaders['frag'],
    });
    material.transparent = true;
    material.opacity = 0.3;

    var line = new THREE.LineSegments( geometry, material );
    scene.add( line );

    camera.position.z = 2;

    function render() {
	requestAnimationFrame( render );
	renderer.render( scene, camera );
    }
    render();
}
