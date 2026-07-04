declare module 'color' {
    type ColorParam = Color | string | ArrayLike<number> | number | { [key: string]: any };

    interface Color {
        color: number[];
        valpha: number;
        model: string;
        luminosity(): number;
        darken(factor: number): Color;
        lighten(factor: number): Color;
        rgb(): Color;
        hsl(): Color;
        hex(): string;
        array(): number[];
        toString(): string;
        string(places?: number): string;
        fade(ratio: number): Color;
        fadeout(ratio: number): Color;
        fadein(ratio: number): Color;
        red(): number;
        green(): number;
        blue(): number;
        hue(): number;
        saturationl(): number;
        lightness(): number;
        alpha(): number;
        alpha(val: number): Color;
        neg(): Color;
        grayscale(): Color;
        clearer(ratio: number): Color;
        opaquer(ratio: number): Color;
        rotate(degrees: number): Color;
        contrast(color: Color): number;
    }

    function Color(input: ColorParam, model?: string): Color;
    namespace Color {
        export type ColorInstance = Color;
    }

    export = Color;
}
