"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.transformAddMissingDefaultExport = exports.transformFileImports = exports.transformEsmImports = exports.scanCodeImportsExports = void 0;
const scan_imports_1 = require("./scan-imports");
const util_1 = require("./util");
const { parse } = require('es-module-lexer');
const WEBPACK_MAGIC_COMMENT_REGEX = /\/\*[\s\S]*?\*\//g;
function applyRewrites(source, rewrites) {
    let result = ``;
    let index = 0;
    rewrites
        .sort((a, b) => a.start - b.start)
        .forEach(({ start, end, rewrite }) => {
        result += source.substring(index, start) + rewrite;
        index = end;
    });
    result += source.substring(index);
    return result;
}
async function scanCodeImportsExports(code) {
    const [imports] = await parse(code);
    return imports.filter((imp) => {
        //imp.d = -2 = import.meta.url = we can skip this for now
        if (imp.d === -2) {
            return false;
        }
        // imp.d > -1 === dynamic import
        if (imp.d > -1) {
            const importStatement = code.substring(imp.s, imp.e);
            return !!scan_imports_1.matchDynamicImportValue(importStatement);
        }
        return true;
    });
}
exports.scanCodeImportsExports = scanCodeImportsExports;
async function transformEsmImports(_code, replaceImport) {
    const imports = await scanCodeImportsExports(_code);
    const collectedRewrites = [];
    await Promise.all(imports.map(async (imp) => {
        let spec = _code.substring(imp.s, imp.e).replace(/(\/|\\)+$/, '');
        let webpackMagicCommentMatches;
        if (imp.d > -1) {
            // Extracting comments from spec as they are stripped in `matchDynamicImportValue`
            webpackMagicCommentMatches = spec.match(WEBPACK_MAGIC_COMMENT_REGEX);
            spec = scan_imports_1.matchDynamicImportValue(spec) || '';
        }
        let rewrittenImport = await replaceImport(spec);
        if (imp.d > -1) {
            rewrittenImport = webpackMagicCommentMatches
                ? `${webpackMagicCommentMatches.join(' ')} ${JSON.stringify(rewrittenImport)}`
                : JSON.stringify(rewrittenImport);
        }
        collectedRewrites.push({ rewrite: rewrittenImport, start: imp.s, end: imp.e });
    }));
    const result = applyRewrites(_code, collectedRewrites);
    return result;
}
exports.transformEsmImports = transformEsmImports;
async function transformHtmlImports(code, replaceImport) {
    const collectedRewrites = [];
    let match;
    const jsImportRegex = new RegExp(util_1.HTML_JS_REGEX);
    while ((match = jsImportRegex.exec(code))) {
        const [, scriptTag, scriptCode] = match;
        // Only transform a script element if it contains inlined code / is not empty.
        if (scriptCode.trim()) {
            collectedRewrites.push({
                rewrite: await transformEsmImports(scriptCode, replaceImport),
                start: match.index + scriptTag.length,
                end: match.index + scriptTag.length + scriptCode.length,
            });
        }
    }
    const cssImportRegex = new RegExp(util_1.HTML_STYLE_REGEX);
    while ((match = cssImportRegex.exec(code))) {
        const [, styleTag, styleCode] = match;
        // Only transform a script element if it contains inlined code / is not empty.
        if (styleCode.trim()) {
            collectedRewrites.push({
                rewrite: await transformCssImports(styleCode, replaceImport),
                start: match.index + styleTag.length,
                end: match.index + styleTag.length + styleCode.length,
            });
        }
    }
    const rewrittenCode = applyRewrites(code, collectedRewrites);
    return rewrittenCode;
}
async function transformCssImports(code, replaceImport) {
    const collectedRewrites = [];
    let match;
    const importRegex = new RegExp(util_1.CSS_REGEX);
    while ((match = importRegex.exec(code))) {
        const [fullMatch, spec] = match;
        // Only transform a script element if it contains inlined code / is not empty.
        collectedRewrites.push({
            // CSS doesn't support proxy files, so always point to the original file
            rewrite: `@import "${(await replaceImport(spec)).replace('.proxy.js', '')}";`,
            start: match.index,
            end: match.index + fullMatch.length,
        });
    }
    const rewrittenCode = applyRewrites(code, collectedRewrites);
    return rewrittenCode;
}
async function transformFileImports({ type, contents }, replaceImport) {
    if (type === '.js') {
        return transformEsmImports(contents, replaceImport);
    }
    if (type === '.html') {
        return transformHtmlImports(contents, replaceImport);
    }
    if (type === '.css') {
        return transformCssImports(contents, replaceImport);
    }
    throw new Error(`Incompatible filetype: cannot scan ${type} files for ESM imports. This is most likely an error within Snowpack.`);
}
exports.transformFileImports = transformFileImports;
async function transformAddMissingDefaultExport(_code) {
    // We need to add a default export, just so that our re-importer doesn't break
    const [, allExports] = await parse(_code);
    if (!allExports.includes('default')) {
        return _code + '\n\nexport default null;';
    }
    return _code;
}
exports.transformAddMissingDefaultExport = transformAddMissingDefaultExport;
