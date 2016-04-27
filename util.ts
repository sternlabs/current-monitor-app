export function mean(ary: number[] | Float32Array) {
    // .reduce type signature is subtely different...
    if (ary instanceof Float32Array) {
        return ary.reduce(function(a: number, b:number){return a+b;})/ary.length;
    } else {
        return ary.reduce(function(a: number, b:number){return a+b;})/ary.length;
    }
}
