uniform vec2 ybounds;
uniform float alpha;

float
scale(float z) {
        return log(z + sqrt(pow(z, 2.0) + pow(alpha, 2.0)));
}

void main() {
        vec2 yscalebounds = vec2(scale(ybounds[0]), scale(ybounds[1]));
        float yscale = 2.0 / abs(yscalebounds[0] - yscalebounds[1]);
        float yoffset = yscalebounds[1];

        float y = (scale(position[1]) - yoffset) * yscale + 1.0;
        gl_Position = vec4(position[0], y, position[2], 1.0);
}
