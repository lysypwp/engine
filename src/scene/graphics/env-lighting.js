import { Vec4 } from '../../core/math/vec4.js';
import { Texture } from '../../platform/graphics/texture.js';
import { reprojectTexture } from './reproject-texture.js';
import {
    TEXTURETYPE_DEFAULT, TEXTURETYPE_RGBP as RGBA8_TYPE,
    TEXTUREPROJECTION_EQUIRECT,
    ADDRESS_CLAMP_TO_EDGE,
    PIXELFORMAT_RGBA8, PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F
} from '../../platform/graphics/constants.js';
import { DebugGraphics } from '../../platform/graphics/debug-graphics.js';

const fixCubemapSeams = true;

// calculate the number of mipmap levels given texture dimensions
const calcLevels = (width, height = 0) => {
    return 1 + Math.floor(Math.log2(Math.max(width, height)));
};

const supportsFloat16 = (device) => {
    return device.extTextureHalfFloat && device.textureHalfFloatRenderable;
};

const supportsFloat32 = (device) => {
    return device.extTextureFloat && device.textureFloatRenderable;
};

// lighting source should be stored HDR
const lightingSourcePixelFormat = (device) => {
    return supportsFloat16(device) ? PIXELFORMAT_RGBA16F :
        supportsFloat32(device) ? PIXELFORMAT_RGBA32F :
            PIXELFORMAT_RGBA8;
};

// runtime lighting can be RGBM
const lightingPixelFormat = (device) => {
    return PIXELFORMAT_RGBA8;
};

const createCubemap = (device, size, format, mipmaps) => {
    return new Texture(device, {
        name: `lighting-${size}`,
        cubemap: true,
        width: size,
        height: size,
        format: format,
        type: format === PIXELFORMAT_RGBA8 ? RGBA8_TYPE : TEXTURETYPE_DEFAULT,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE,
        fixCubemapSeams: fixCubemapSeams,
        mipmaps: !!mipmaps
    });
};

/**
 * Helper functions to support prefiltering lighting data.
 *
 * @ignore
 */
class EnvLighting {
    /**
     * Generate a skybox cubemap in the correct pixel format from the source texture.
     *
     * @param {Texture} source - The source texture. This is either a 2d texture in equirect format
     * or a cubemap.
     * @param {number} [size] - Size of the resulting texture. Otherwise use automatic sizing.
     * @returns {Texture} The resulting cubemap.
     */
    static generateSkyboxCubemap(source, size) {
        const device = source.device;

        DebugGraphics.pushGpuMarker(device, 'genSkyboxCubemap');

        const result = createCubemap(device, size || (source.cubemap ? source.width : source.width / 4), PIXELFORMAT_RGBA8, false);

        reprojectTexture(source, result, {
            numSamples: 1024
        });

        DebugGraphics.popGpuMarker(device);

        return result;
    }

    /**
     * Create a texture in the format needed to precalculate lighting data.
     *
     * @param {Texture} source - The source texture. This is either a 2d texture in equirect format
     * or a cubemap.
     * @param {object} [options] - Specify generation options.
     * @param {Texture} [options.target] - The target texture. If one is not provided then a
     * new texture will be created and returned.
     * @param {number} [options.size] - Size of the lighting source cubemap texture. Only used
     * if target isn't specified. Defaults to 128.
     * @returns {Texture} The resulting cubemap.
     */
    static generateLightingSource(source, options) {
        const device = source.device;

        DebugGraphics.pushGpuMarker(device, 'genLightingSource');

        const format = lightingSourcePixelFormat(device);
        const result = options?.target || new Texture(device, {
            name: 'lighting-source',
            cubemap: true,
            width: options?.size || 128,
            height: options?.size || 128,
            format: format,
            type: format === PIXELFORMAT_RGBA8 ? RGBA8_TYPE : TEXTURETYPE_DEFAULT,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            fixCubemapSeams: false,
            mipmaps: true
        });

        // copy into top level
        reprojectTexture(source, result, {
            numSamples: source.mipmaps ? 1 : 1024
        });

        DebugGraphics.popGpuMarker(device);

        // generate mipmaps
        return result;
    }

    /**
     * Generate the environment lighting atlas containing prefiltered reflections and ambient.
     *
     * @param {Texture} source - The source lighting texture, generated by generateLightingSource.
     * @param {object} [options] - Specify prefilter options.
     * @param {Texture} [options.target] - The target texture. If one is not provided then a
     * new texture will be created and returned.
     * @param {number} [options.size] - Size of the target texture to create. Only used if
     * target isn't specified. Defaults to 512.
     * @param {number} [options.numReflectionSamples] - Number of samples to use when generating
     * rough reflections. Defaults to 1024.
     * @param {number} [options.numAmbientSamples] - Number of samples to use when generating ambient
     * lighting. Defaults to 2048.
     * @returns {Texture} The resulting atlas
     */
    static generateAtlas(source, options) {
        const device = source.device;
        const format = lightingPixelFormat(device);

        DebugGraphics.pushGpuMarker(device, 'genAtlas');

        const result = options?.target || new Texture(device, {
            name: 'envAtlas',
            width: options?.size || 512,
            height: options?.size || 512,
            format: format,
            type: format === PIXELFORMAT_RGBA8 ? RGBA8_TYPE : TEXTURETYPE_DEFAULT,
            projection: TEXTUREPROJECTION_EQUIRECT,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            mipmaps: false
        });

        DebugGraphics.pushGpuMarker(device, 'mipmaps');

        const s = result.width / 512;

        // generate mipmaps
        const rect = new Vec4(0, 0, 512 * s, 256 * s);
        const levels = calcLevels(256) - calcLevels(4);
        for (let i = 0; i < levels; ++i) {
            reprojectTexture(source, result, {
                numSamples: 1,
                rect: rect,
                seamPixels: s
            });

            rect.x += rect.w;
            rect.y += rect.w;
            rect.z = Math.max(1, Math.floor(rect.z * 0.5));
            rect.w = Math.max(1, Math.floor(rect.w * 0.5));
        }

        DebugGraphics.popGpuMarker(device);
        DebugGraphics.pushGpuMarker(device, 'reflections');

        // generate blurry reflections
        rect.set(0, 256 * s, 256 * s, 128 * s);
        for (let i = 1; i < 7; ++i) {
            reprojectTexture(source, result, {
                numSamples: options?.numReflectionSamples || 1024,
                distribution: options?.distribution || 'ggx',
                specularPower: Math.max(1, 2048 >> (i * 2)),
                rect: rect,
                seamPixels: s
            });
            rect.y += rect.w;
            rect.z = Math.max(1, Math.floor(rect.z * 0.5));
            rect.w = Math.max(1, Math.floor(rect.w * 0.5));
        }

        DebugGraphics.popGpuMarker(device);
        DebugGraphics.pushGpuMarker(device, 'ambient');

        // generate ambient
        rect.set(128 * s, (256 + 128) * s, 64 * s, 32 * s);
        reprojectTexture(source, result, {
            numSamples: options?.numAmbientSamples || 2048,
            distribution: 'lambert',
            rect: rect,
            seamPixels: s
        });

        DebugGraphics.popGpuMarker(device);
        DebugGraphics.popGpuMarker(device);

        return result;
    }

    /**
     * Generate the environment lighting atlas from prefiltered cubemap data.
     *
     * @param {Texture[]} sources - Array of 6 prefiltered textures.
     * @param {object} [options] - The options object
     * @param {Texture} [options.target] - The target texture. If one is not provided then a
     * new texture will be created and returned.
     * @param {number} [options.size] - Size of the target texture to create. Only used if
     * target isn't specified. Defaults to 512.
     * @param {boolean} [options.legacyAmbient] - Enable generating legacy ambient lighting.
     * Default is false.
     * @param {number} [options.numSamples] - Number of samples to use when generating ambient
     * lighting. Default is 2048.
     * @returns {Texture} The resulting atlas texture.
     */
    static generatePrefilteredAtlas(sources, options) {
        const device = sources[0].device;
        const format = sources[0].format;
        const type = sources[0].type;

        DebugGraphics.pushGpuMarker(device, 'genPrefilteredAtlas');

        const result = options?.target || new Texture(device, {
            name: 'envPrefilteredAtlas',
            width: options?.size || 512,
            height: options?.size || 512,
            format: format,
            type: type,
            projection: TEXTUREPROJECTION_EQUIRECT,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            mipmaps: false
        });

        DebugGraphics.pushGpuMarker(device, 'mipmaps');

        const s = result.width / 512;

        // generate mipmaps
        const rect = new Vec4(0, 0, 512 * s, 256 * s);
        const levels = calcLevels(512);
        for (let i = 0; i < levels; ++i) {
            reprojectTexture(sources[0], result, {
                numSamples: 1,
                rect: rect,
                seamPixels: s
            });

            rect.x += rect.w;
            rect.y += rect.w;
            rect.z = Math.max(1, Math.floor(rect.z * 0.5));
            rect.w = Math.max(1, Math.floor(rect.w * 0.5));
        }

        DebugGraphics.popGpuMarker(device);
        DebugGraphics.pushGpuMarker(device, 'reflections');

        // copy blurry reflections
        rect.set(0, 256 * s, 256 * s, 128 * s);
        for (let i = 1; i < sources.length; ++i) {
            reprojectTexture(sources[i], result, {
                numSamples: 1,
                rect: rect,
                seamPixels: s
            });
            rect.y += rect.w;
            rect.z = Math.max(1, Math.floor(rect.z * 0.5));
            rect.w = Math.max(1, Math.floor(rect.w * 0.5));
        }

        DebugGraphics.popGpuMarker(device);
        DebugGraphics.pushGpuMarker(device, 'ambient');

        // generate ambient
        rect.set(128 * s, (256 + 128) * s, 64 * s, 32 * s);
        if (options?.legacyAmbient) {
            reprojectTexture(sources[5], result, {
                numSamples: 1,
                rect: rect,
                seamPixels: s
            });
        } else {
            reprojectTexture(sources[0], result, {
                numSamples: options?.numSamples || 2048,
                distribution: 'lambert',
                rect: rect,
                seamPixels: s
            });
        }

        DebugGraphics.popGpuMarker(device);
        DebugGraphics.popGpuMarker(device);

        return result;
    }
}

export {
    EnvLighting
};
