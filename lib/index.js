require('colors');

const { promisify } = require('util');
const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');
const handlebars = require('handlebars');
const fontGenerator = promisify(require('webfonts-generator'));
const {
  CSS_PARSE_REGEX,
  FONT_TYPES,
  TEMPLATES,
  OPTIONAL_PARAMS,
  DEFAULT_OPTIONS,
  FORMATS,
} = require('./constants')
const { ValidationError } = require('./error');
const {
  log,
  logOutput,
} = require('./utils');
const fsAsync = {
  exists: promisify(fs.exists),
  stat: promisify(fs.stat),
  unlink: promisify(fs.unlink),
  readFile: promisify(fs.readFile),
  writeFile: promisify(fs.writeFile),
};

registerHelperHandlebars();

/**
 * Generate icon font set asynchronously
 *
 * @param  {Object} options
 * @param  {Function} callback
 * @return {void}
 */
async function generate(options = {}) {
  options = Object.assign(DEFAULT_OPTIONS, options);

  let msg = `Generating font icon from ${ options.paths.length } SVG icons`.yellow;
  log(options, msg);

  await validateOptions(options);

  /* eslint-disable require-atomic-updates */
  if (options.codepoints) {
    options.codepointsMap = await getCodepointsMap(options.codepoints);
  }

  const generatorResult = await generateFont(options);

  if (options.json) {
    await generateJson(options, generatorResult);
  }

  if (options.styledComponent) {
    await generateStyledComponent(options, generatorResult);
  }

  logReport(options);
}

function registerHelperHandlebars() {
  handlebars.registerHelper('toLowerCase', (str) => {
    return str.toLowerCase();
  });

  handlebars.registerHelper('toUpperCase', (str) => {
    return str.toUpperCase();
  });

  handlebars.registerHelper('selectIcon', (list, key) => {
    const icon = list.find(item => item.key === key);
    return icon && icon.value;
  });
}

async function generateStyledComponent(options, generatorResult) {
  const source = fs.readFileSync(TEMPLATES.styledComponent, 'utf8');
  const template = handlebars.compile(source);
  const styledComponentPath = `${ path.join(options.outputDir, '/' + options.fontName) }.jsx`;
  const jsonIcons = parseJsonFromCss(generatorResult);
  const listIcons = [];
  for (let key in jsonIcons) {
    listIcons.push({
      key,
      name: 'Icon' + capitalizeWord(key.replace(/-/g, ' ')).replace(/ /g, ''),
      value: jsonIcons[key].replace(/\\/g, ''),
    })
  }

  // export const IconFont = styled.{{../baseTag}}`
  //   font-family: "{{../fontName}}" !important;
  //   font-size: ${props => props.size || '22px'};
  //   color: ${props => props.color || 'inherit'};
  //   vertical-align: ${props => props.vertical || 'middle'};
  //   &:before {
  //     content: "\\{{ selectIcon listIcons "video-off-setting" }}";
  //   }
  // `;

  options.listIcons = listIcons;
  options.baseTag = options.baseTag || 'i';
  options.types = options.types.reverse();

  mkdirp.sync(path.dirname(options.outputDir));
  fs.writeFileSync(styledComponentPath, template(options));
}

async function generateFont(options) {
  const config = getGeneratorConfig(options);
  const generatorResult = await fontGenerator(config);

  await deleteUnspecifiedTypes(options);

  return generatorResult;
}

/**
 * Transform options Object in a configuration accepted by the generator
 *
 * @param  {Object} options
 * @return {void}
 */
function getGeneratorConfig(options) {
  const { tag, classNames } = parseSelector(options.baseSelector);
  const config = {
    files: options.paths,
    dest: options.outputDir,
    types: options.types,
    codepoints: options.codepointsMap,
    startCodepoint: options.startCodepoint || 0xF101,
    cssDest: options.cssPath,
    cssFontsUrl: getCssFontsUrl(options),
    htmlDest: options.htmlPath,
    cssTemplate: options.cssTemplate  || TEMPLATES.css,
    htmlTemplate: options.htmlTemplate || TEMPLATES.html,
    templateOptions: {
      baseTag: tag || options.baseTag || 'i',
      baseSelector: options.baseSelector || null,
      baseClassNames: classNames.join(' '),
      classPrefix: (options.classPrefix || 'icon') + '-',
      htmlCssRelativePath: path.relative(
        path.dirname(getResolvedPath(options, 'html')),
        getResolvedPath(options, 'css'),
      ),
    },
    rename: (file) => formatIconName(file),
  }

  OPTIONAL_PARAMS.forEach(key => {
    if (typeof options[key] !== 'undefined') {
      if (`${ parseFloat(options[key]) }` === `${ options[key] }`) {
        options[key] = parseFloat(options[key]);
      }

      config[key] = options[key];
    }
  })

  return config;
}

function formatIconName(file) {
  let fileName = path.basename(file, path.extname(file)).toLocaleLowerCase();
  let iconName = fileName.replace(/_/g, '-').replace(/ /g, '-');
  return iconName;
}

function capitalizeWord(str) {
  const splitStr = str.toLowerCase().split(' ');
  for (let i = 0; i < splitStr.length; i++) {
    splitStr[i] = splitStr[i].charAt(0).toUpperCase() + splitStr[i].substring(1);
  }
  return splitStr.join(' ');
}

/**
 * Parse tag and classNames from given selector, if any are specified
 *
 * @param  {?String} selector
 * @return {Object}
 */
function parseSelector(selector = '') {
  const tagMatch = selector.match(/^[a-zA-Z0-9='"[\]_-]*/g);
  const classNamesMatch = selector.match(/\.[a-zA-Z0-1_-]*/g);

  return {
    tag: tagMatch ? tagMatch[0] : undefined,
    classNames: classNamesMatch ? classNamesMatch.map(cname => cname.substr(1)) : [],
  }
}

/**
 * Based on given options, compute value that should be used as a base URL for font files from the generated CSS
 *
 * If a `cssFontsUrl` option is explicitally provided, it overrides default behaviour
 *
 * Else if the CSS was output at a custom filepath, compute a relative path from there
 *
 * Just return './' otherwise
 *
 * @param  {Object} options
 * @return {void}
 */
function getCssFontsUrl(options) {
  if (options.cssFontsUrl) {
    return options.cssFontsUrl;
  }

  if (options.cssPath) {
    return path.relative(path.dirname(options.cssPath), options.outputDir);
  }

  return './';
}

/**
 * Correctly parse codepoints map
 *
 * @param  {Object} options
 * @return {void}
 */
async function getCodepointsMap(filepath) {
  const content = await fsAsync.readFile(filepath);
  let codepointsMap = null;

  try {
    codepointsMap = JSON.parse(content);
  } catch (e) {
    throw new ValidationError('Codepoints map is invalid JSON');
  }

  for (let propName in codepointsMap) {
    codepointsMap[propName] = Number.parseInt(codepointsMap[propName]);
  }

  return codepointsMap;
}

/**
 * Assume the absolute path at which the file of given type should be written
 *
 * @param  {Object} options
 * @param  {?String} type
 * @return {void}
 */
function getResolvedPath(options, type = 'html') {
  const explicitPathKey = `${ type }Path`;

  if (options[explicitPathKey]) {
    return path.resolve(options[explicitPathKey]);
  }

  return path.resolve(options.outputDir, `${ options.fontName }.${ type }`);
}

/**
 * Log report with all generated files and completion message
 *
 * @param  {Object} options
 * @return {void}
 */
function logReport(options) {
  const { outputDir, fontName } = options;

  for (let ext of options.types) {
    logOutput(options, [ outputDir, `${ fontName }.${ ext }` ]);
  }

  if (options.html) {
    logOutput(options, [ getResolvedPath(options, 'html') ]);
  }

  if (options.css) {
    logOutput(options, [ getResolvedPath(options, 'css') ]);
  }

  if (options.json) {
    logOutput(options, [ getResolvedPath(options, 'json') ]);
  }

  log(options, 'Done'.green);
}

/**
 * Generate JSON icons map by parsing the generated CSS
 *
 * @param  {Object} options
 * @return {void}
 */
async function generateJson(options, generatorResult) {
  const jsonPath = (
    options.jsonPath ||
    `${ path.join(options.outputDir, '/' + options.fontName) }.json`
  );

  let map = parseJsonFromCss(generatorResult);

  await fsAsync.writeFile(jsonPath, JSON.stringify(map, null, 2));
}

function parseJsonFromCss(generatorResult) {
  const css = generatorResult.generateCss();
  let map = {};

  css.replace(CSS_PARSE_REGEX, (match, name, code) => map[name] = code);
  return map;
}

/**
 * Delete generated fonts with extensions that weren't specified
 *
 * @param  {Object} options
 * @return {void}
 */
async function deleteUnspecifiedTypes(options) {
  const { outputDir, fontName, types } = options;

  for (let ext of FONT_TYPES) {
    if (types.indexOf(ext) !== -1) {
      continue;
    }

    let filepath = path.resolve(outputDir, `${ fontName }.${ ext }`);

    if (await fsAsync.exists(filepath)) {
      await fsAsync.unlink(filepath);
    }
  }
}

async function validationDir(options) {
  if (!options.paths.length) {
    throw new ValidationError('No paths specified')
  }

  if (!options.outputDir) {
    throw new ValidationError('Please specify an output directory with -o or --output')
  }

  if (!await fsAsync.exists(options.outputDir)) {
    throw new ValidationError('Output directory doesn\'t exist')
  }

  const outStat = await fsAsync.stat(options.outputDir)
  if (!outStat.isDirectory()) {
    throw new ValidationError('Output path must be a directory')
  }
}

async function validationTemplate(options) {
  if (options.cssTemplate && !await fsAsync.exists(options.cssTemplate)) {
    throw new ValidationError('CSS template not found')
  }

  if (options.htmlTemplate && !await fsAsync.exists(options.htmlTemplate)) {
    throw new ValidationError('HTML template not found')
  }
}

function validationPath(options) {
  FORMATS.forEach(key => {
    const explicitPathKey = `${ key }Path`
    if (options[explicitPathKey] === '') {
      throw new ValidationError(`${key}path must not be blank`)
    } else if (options[explicitPathKey] && typeof options[explicitPathKey] !== 'string') {
      throw new ValidationError(`${key}path must be string and not be blank`)
    }
  })
}

/**
 * Asynchronously validate generation options, check existance of given files and directories
 *
 * @throws
 * @param  {Object} options
 * @return {void}
 */

async function validateOptions(options) {
  validationDir(options);
  validationTemplate(options);
  validationPath(options);

  if (options.codepoints) {
    if (!await fsAsync.exists(options.codepoints)) {
      throw new ValidationError(`Cannot find json file @ ${options.codepoints}!`)
    }

    const codepointsStat = await fsAsync.stat(options.codepoints)
    if (!codepointsStat.isFile() || path.extname(options.codepoints) !== '.json') {
      throw new ValidationError([
        'Codepoints file must be JSON',
        `${options.codepoints} is not a valid file.`
      ].join(' '))
    }
  }
}

module.exports = {
  generate,
};
