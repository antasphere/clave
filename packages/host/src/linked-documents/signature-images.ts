import { Parser } from 'htmlparser2'
import { Resvg } from '@resvg/resvg-js'
import valueParser from 'postcss-value-parser'

/** Parse every CSS URL, including quoted data URLs, commas and repeated layers. */
export function mapCssImages(style: string, map: (source: string) => string): string {
  const parsed = valueParser(style)
  parsed.walk((node) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return
    const value = node.nodes.filter((n) => n.type !== 'space' && n.type !== 'comment')
    if (node.unclosed || value.length !== 1 || !['word', 'string'].includes(value[0].type))
      throw new Error('Unsupported CSS image URL')
    node.nodes = [
      {
        type: 'string',
        quote: '"',
        value: map(value[0].value),
        sourceIndex: node.sourceIndex,
        sourceEndIndex: node.sourceEndIndex
      }
    ]
    return false
  })
  return parsed.toString()
}

/** Only bounded, self-contained vector shapes/filters reach resvg. No resources or fonts can resolve. */
export function rasterizeSvgData(source: string): Buffer {
  const match = /^data:image\/svg\+xml(?:;charset=[\w-]+)?(;base64)?,([\s\S]+)$/i.exec(source)
  if (!match) throw new Error('Unsupported SVG data URL')
  const svg = match[1]
    ? Buffer.from(match[2], 'base64').toString('utf8')
    : decodeURIComponent(match[2])
  if (Buffer.byteLength(svg) > 100000 || /<!DOCTYPE|<!ENTITY|<\?/i.test(svg))
    throw new Error('SVG must be a small self-contained image')
  const tags = new Set([
    'svg',
    'g',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'defs',
    'linearGradient',
    'radialGradient',
    'stop',
    'filter',
    'feTurbulence',
    'feColorMatrix',
    'feBlend',
    'feComposite',
    'feGaussianBlur',
    'feOffset',
    'feFlood',
    'feMerge',
    'feMergeNode',
    'clipPath',
    'mask'
  ])
  const attributes = new Set([
    'xmlns',
    'width',
    'height',
    'viewBox',
    'preserveAspectRatio',
    'id',
    'fill',
    'fill-opacity',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-linecap',
    'stroke-linejoin',
    'opacity',
    'transform',
    'd',
    'x',
    'y',
    'x1',
    'x2',
    'y1',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'points',
    'offset',
    'stop-color',
    'stop-opacity',
    'gradientUnits',
    'gradientTransform',
    'spreadMethod',
    'filter',
    'filterUnits',
    'primitiveUnits',
    'type',
    'baseFrequency',
    'numOctaves',
    'stitchTiles',
    'seed',
    'result',
    'in',
    'in2',
    'values',
    'mode',
    'operator',
    'k1',
    'k2',
    'k3',
    'k4',
    'stdDeviation',
    'dx',
    'dy',
    'flood-color',
    'flood-opacity',
    'clip-path',
    'mask'
  ])
  let count = 0,
    rootSeen = false,
    width = 0,
    height = 0
  new Parser(
    {
      onopentag(tag, attrs) {
        if (++count > 500 || !tags.has(tag)) throw new Error('Unsupported SVG element')
        if (!rootSeen) {
          if (tag !== 'svg') throw new Error('SVG root required')
          rootSeen = true
          const dimension = (value: string): number =>
            /^\d+(?:\.\d+)?(?:px)?$/.test(value ?? '') ? parseFloat(value) : NaN
          width = dimension(attrs.width)
          height = dimension(attrs.height)
          if (!(width > 0 && height > 0 && width <= 1024 && height <= 1024))
            throw new Error('SVG needs explicit dimensions up to 1024 × 1024')
        }
        for (const [key, value] of Object.entries(attrs)) {
          if (key === 'xmlns' && value === 'http://www.w3.org/2000/svg') continue
          if (!attributes.has(key) || /(?:https?:|file:|data:|@import|\\)/i.test(value))
            throw new Error('SVG external resources and active content are unsupported')
          if (/url\s*\(/i.test(value) && !/^url\(#[\w-]+\)$/.test(value))
            throw new Error('SVG references must stay inside the image')
          if (key === 'numOctaves' && !(Number(value) >= 1 && Number(value) <= 4))
            throw new Error('SVG filter complexity exceeds limit')
          if (key === 'stdDeviation' && Number(value) > 20)
            throw new Error('SVG filter complexity exceeds limit')
        }
      }
    },
    { xmlMode: true }
  ).end(svg)
  if (!rootSeen) throw new Error('SVG root required')
  const renderer = new Resvg(svg, {
    font: { loadSystemFonts: false, fontFiles: [], fontDirs: [] },
    logLevel: 'off'
  })
  if (renderer.imagesToResolve().length || renderer.width > 1024 || renderer.height > 1024)
    throw new Error('SVG external resources or dimensions exceed limits')
  const bytes = renderer.render().asPng()
  if (bytes.length > 2000000) throw new Error('Rasterized signature image exceeds 2 MB')
  return bytes
}
