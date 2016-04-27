const segmentSize = (16*1024*1024)/4;

class SampleSegment {
    pos: number;
    samples: Float32Array;

    constructor(size: number) {
        this.samples = new Float32Array(size);
        this.pos = 0;
    }

    store(samples: Float32Array): Float32Array {
        let space = this.free();
        let source = samples;
        let rest: Float32Array;
        if (samples.length > space) {
            source = samples.subarray(0, space);
            rest = samples.subarray(space);
        } else {
            rest = samples.subarray(0, 0);
        }
        this.samples.set(source, this.pos);
        this.pos += source.length;
        return rest;
    }

    get(offset: number, count: number): Float32Array {
        if (offset > 0 && offset + count > this.pos) {
            count = this.pos - offset;
        } else if (offset < 0 && -offset > count) {
            count = -offset;
        }
        return this.samples.subarray(offset, offset+count);
    }

    length(): number {
        return this.pos;
    }

    free(): number {
        return this.samples.length - this.pos;
    }
}

export class SampleBuffer {
    rate: number;
    segments: SampleSegment[] = [];

    constructor(rate: number) {
        this.rate = rate;
        this.allocSegment();
    }

    allocSegment() {
        let seg = new SampleSegment(segmentSize);
        this.segments.push(seg);
    }

    store(samples: Float32Array) {
        while (samples.length > 0) {
            let seg = this.segments[this.segments.length-1];
            console.log("storing on "+this.segments.length+" offset "+seg.pos)
            samples = seg.store(samples);
            if (seg.free() == 0) {
                this.allocSegment()
            }
        }
    }

    get(offset: number, count: number) {
        let [seg, segoff] = this.offset2seg(offset);
        let dataoff = 0;
        console.log("offset "+offset+" seg "+seg+" segoff "+segoff);
        let data = new Float32Array(count);
        for (; count > 0 && seg < this.segments.length; seg++, segoff = 0) {
            let segdata = this.segments[seg].get(segoff, count);
            console.log("data: "+segdata[0]);
            data.set(segdata, dataoff);
            dataoff += segdata.length;
            count -= segdata.length;
        }
        return data;
    }

    offset2seg(offset: number) {
        let seg = 0;
        let dir = 1;
        if (offset < 0) {
            offset += 1;
            seg = this.segments.length-1;
            dir = -1;
        }
        for (; seg != this.segments.length && seg != -1; seg += dir) {
            let l = this.segments[seg].length();
            if (dir * offset < l) {
                break;
            }
            offset -= dir * l;
        }

        if (dir == -1 && seg == -1) {
            seg = 0; offset = 0;
        } else if (dir == -1) {
            offset += this.segments[seg].length() - 1;
        }else if (dir == 1 && seg == this.segments.length) {
            seg = this.segments.length-1;
            offset = this.segments[seg].length();
        }

        return [seg, offset];
    }

    getByTime(startT: number, duration: number) {
        let start = this.time2offset(startT);
        let count = this.time2offset(duration);
        return this.get(start, count);
    }

    time2offset(time: number): number {
        return time * this.rate;
    }
}
