export function mean(ary: number[]) {
    return ary.reduce(function(a,b){return a+b;})/ary.length;
}
