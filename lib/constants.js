const path = require('path');
const CSS_PARSE_REGEX = /-(.*):before.*\r?\n\s*content: "(.*)"/gm;
const FONT_TYPES = ['svg', 'ttf', 'woff', 'woff2', 'eot'];

const TEMPLATES = {
  html: path.resolve(__dirname, './template/html.hbs'),
  css: path.resolve(__dirname, './template/css.hbs'),
  styledComponent: path.resolve(__dirname, './template/style-component.hbs'),
};

const OPTIONAL_PARAMS = [
  'css',
  'html',
  'fontName',
  'classPrefix',
  'normalize',
  'round',
  'fixedWidth',
  'fontHeight',
  'descent',
  'fontHeight',
  'centerHorizontally'
];

const FORMATS = [
  'html',
  'css',
  'json'
];

const DEFAULT_OPTIONS = {
  fontName: 'icon-font',
  css: true,
  json: true,
  html: true,
  silent: true,
  types: FONT_TYPES,
  templateOptions: {}
};

module.exports = {
  CSS_PARSE_REGEX,
  FONT_TYPES,
  TEMPLATES,
  OPTIONAL_PARAMS,
  DEFAULT_OPTIONS,
  FORMATS,
}
