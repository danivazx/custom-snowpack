"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLoader = void 0;
const fs_1 = require("fs");
const url_1 = require("url");
const sourcemaps_1 = require("./sourcemaps");
const transform_1 = require("./transform");
const util_1 = require("../util");
function moduleInit(fn) {
    let promise = null;
    return function () {
        return promise || (promise = fn());
    };
}
// This function makes it possible to load modules from the snowpack server, for the sake of SSR.
function createLoader({ config, load }) {
    const cache = new Map();
    const graph = new Map();
    async function getModule(importer, imported, urlStack) {
        if (imported[0] === '/' || imported[0] === '.') {
            const pathname = url_1.resolve(importer, imported);
            if (!graph.has(pathname))
                graph.set(pathname, new Set());
            graph.get(pathname).add(importer);
            return _load(pathname, urlStack);
        }
        return moduleInit(async function () {
            const mod = await util_1.REQUIRE_OR_IMPORT(imported, {
                from: config.root || config.workspaceRoot || process.cwd(),
            });
            return {
                exports: mod,
                css: [],
            };
        });
    }
    function invalidateModule(path) {
        // If the cache doesn't have this path, check if it's a proxy file.
        if (!cache.has(path) && cache.has(path + '.proxy.js')) {
            path = path + '.proxy.js';
        }
        cache.delete(path);
        const dependents = graph.get(path);
        graph.delete(path);
        if (dependents)
            dependents.forEach(invalidateModule);
    }
    async function _load(url, urlStack) {
        if (urlStack.includes(url)) {
            console.warn(`Circular dependency: ${urlStack.join(' -> ')} -> ${url}`);
            return async () => ({
                exports: null,
                css: [],
            });
        }
        if (cache.has(url)) {
            return cache.get(url);
        }
        const promise = (async function () {
            const loaded = await load(url);
            return moduleInit(function () {
                try {
                    return initializeModule(url, loaded, urlStack.concat(url));
                }
                catch (e) {
                    cache.delete(url);
                    throw e;
                }
            });
        })();
        cache.set(url, promise);
        return promise;
    }
    async function initializeModule(url, loaded, urlStack) {
        const { code, deps, css, names } = transform_1.transform(loaded.contents);
        const exports = {};
        const allCss = new Set(css.map((relative) => url_1.resolve(url, relative)));
        const fileURL = loaded.originalFileLoc ? url_1.pathToFileURL(loaded.originalFileLoc) : null;
        // Load dependencies but do not execute.
        const depsLoaded = deps.map(async (dep) => {
            return {
                name: dep.name,
                init: await getModule(url, dep.source, urlStack),
            };
        });
        // Execute dependencies *in order*.
        const depValues = [];
        for await (const { name, init } of depsLoaded) {
            const module = await init();
            module.css.forEach((dep) => allCss.add(dep));
            depValues.push({
                name: name,
                value: module.exports,
            });
        }
        const args = [
            {
                name: 'global',
                value: global,
            },
            {
                name: 'require',
                value: (id) => {
                    // TODO can/should this restriction be relaxed?
                    throw new Error(`Use import instead of require (attempted to load '${id}' from '${url}')`);
                },
            },
            {
                name: names.exports,
                value: exports,
            },
            {
                name: names.__export,
                value: (name, get) => {
                    Object.defineProperty(exports, name, { get });
                },
            },
            {
                name: names.__export_all,
                value: (mod) => {
                    // Copy over all of the descriptors.
                    const descriptors = Object.getOwnPropertyDescriptors(mod);
                    Object.defineProperties(exports, descriptors);
                },
            },
            {
                name: names.__import,
                value: (source) => getModule(url, source, urlStack)
                    .then((fn) => fn())
                    .then((mod) => mod.exports),
            },
            {
                name: names.__import_meta,
                value: { url: fileURL },
            },
            ...depValues,
        ];
        const fn = new Function(...args.map((d) => d.name), `${code}\n//# sourceURL=${url}`);
        try {
            fn(...args.map((d) => d.value));
        }
        catch (e) {
            e.stack = await sourcemaps_1.sourcemap_stacktrace(e.stack, async (address) => {
                if (fs_1.existsSync(address)) {
                    // it's a filepath
                    return fs_1.readFileSync(address, 'utf-8');
                }
                try {
                    const { contents } = await load(address);
                    return contents;
                }
                catch (_a) {
                    // fail gracefully
                }
            });
            throw e;
        }
        return {
            exports,
            css: Array.from(allCss),
        };
    }
    return {
        importModule: async (url) => {
            const init = await _load(url, []);
            const mod = await init();
            return mod;
        },
        invalidateModule: (url) => {
            invalidateModule(url);
        },
    };
}
exports.createLoader = createLoader;
