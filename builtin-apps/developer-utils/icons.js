// Local vector marks share one viewBox and stroke weight; no font glyph sizing.
const paths = {
  search: 'm21 21-4.34-4.34M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  settings: 'M10 2h4l.5 3 2 1.2 2.9-1 2 3.5-2.3 2v2.6l2.3 2-2 3.5-2.9-1-2 1.2-.5 3h-4l-.5-3-2-1.2-2.9 1-2-3.5 2.3-2v-2.6l-2.3-2 2-3.5 2.9 1 2-1.2ZM15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0',
  time: 'M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Zm0 4v5l-3 2',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18',
  wand: 'm4 17 12-12 3 3L7 20Zm9-9 3 3M5 3v4M3 5h4m12 10v6m-3-3h6',
  base64: 'M10 5H6L3 11v7h7v-7H3m12-6-2 9h8m-3-9v14',
  escape: 'M5 3 11 21m4-6v-5h6v10m-6-6h6',
  percent: 'M5 19 19 5M9 6a3 3 0 1 0-6 0 3 3 0 0 0 6 0m12 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
  json: 'M9 3H7a2 2 0 0 0-2 2v4l-2 3 2 3v4a2 2 0 0 0 2 2h2m6-18h2a2 2 0 0 1 2 2v4l2 3-2 3v4a2 2 0 0 1-2 2h-2',
  image: 'M3 4h18v16H3ZM3 16l5-5 5 5 3-3 5 5M15 8h.01',
  convert: 'M3 7h17l-4-4m5 14H4l4 4M3 7l4 4m14 6-4-4',
  hash: 'M9 3 7 21M17 3l-2 18M3 9h18M2 15h18',
  text: 'M3 5h18M8 5v15m8-15v15M5 20h6m2 0h6',
  regex: 'M5 18h.01M15 3v12M9 6l12 6M21 6 9 12',
  link: 'm9 15 6-6M8 16l-2 2a3 3 0 0 1-4-4l5-5a3 3 0 0 1 4 0m2 6a3 3 0 0 0 4 0l5-5a3 3 0 0 0-4-4l-2 2',
  lock: 'M6 10V7a6 6 0 0 1 12 0v3M4 10h16v11H4Zm8 4v3',
  grid: 'M3 3h6v6H3Zm12 0h6v6h-6ZM3 15h6v6H3Zm12 0h3v3h3v3h-6ZM12 3v6m-9 3h6m3 0h9m-9 3v6',
  color: 'M12 3C9 7 5 11 5 15a7 7 0 0 0 14 0c0-4-4-8-7-12Zm-4 13a4 4 0 0 0 4 3',
  list: 'M8 5h13M8 12h10M8 19h7M3 5h.01M3 12h.01M3 19h.01',
  file: 'M5 2h9l5 5v15H5ZM14 2v6h5M8 12h8m-8 4h8',
  number: 'M4 4h5v6H4Zm11 0h5v6h-5ZM6 14v7m-2 0h4m7-7h5v7h-5Z',
  random: 'M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 3-2 4-4m4-4c1-2 2-4 4-4h3m-4-4 4 4-4 4',
  diff: 'M3 6h7M6.5 2.5v7M14 6h7M3 16h7m4-3h7m-7 6h7',
  copy: 'M8 8h13v13H8ZM16 8V3H3v13h5'
};
const kinds = {
  time: 'time', crontab: 'time', json: 'json', serialize: 'convert', code: 'wand', htmlToJsx: 'code', httpSnippet: 'code', base64: 'base64', backslash: 'escape', hexString: 'convert', html: 'hash',
  base64Image: 'image', svgToCss: 'image', qrCode: 'grid', barcode: 'grid', color: 'color',
  hash: 'hash', hmac: 'hash', jwt: 'lock', certificate: 'file', regex: 'regex', url: 'percent', urlParse: 'link',
  radix: 'number', uuid: 'number', ulid: 'number', randomString: 'random', randomRecipe: 'random', markdown: 'file', stringInspect: 'text', diffs: 'diff', text: 'list', variableConversion: 'text', loremIpsum: 'text'
};
export function iconFor(entry) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[typeof entry === 'string' ? entry : kinds[entry.tool] || (entry.local ? 'code' : entry.group === '加密与校验' ? 'lock' : 'convert')] || paths.code);
  svg.append(path); return svg;
}
