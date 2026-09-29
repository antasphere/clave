import {
  FolderIcon,
  FolderOpenIcon,
  CodeBracketIcon,
  Cog6ToothIcon,
  PhotoIcon,
  DocumentTextIcon,
  DocumentIcon,
  TableCellsIcon,
  KeyIcon,
  XCircleIcon,
  CodeBracketSquareIcon,
  Bars3BottomRightIcon,
  InformationCircleIcon,
  Bars3CenterLeftIcon
} from '@heroicons/react/24/outline'

type IconType =
  | 'folder'
  | 'code'
  | 'config'
  | 'image'
  | 'markdown'
  | 'table'
  | 'license'
  | 'gitignore'
  | 'json'
  | 'yml'
  | 'readme'
  | 'noExt'
  | 'generic'

// Exact filename matches take precedence over extension rules.
const FILENAME_MAP: Record<string, IconType> = {
  LICENSE: 'license',
  '.gitignore': 'gitignore',
  'README.md': 'readme'
}

const EXT_MAP: Record<string, IconType> = {
  // Code
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code',
  py: 'code', rs: 'code', go: 'code', rb: 'code',
  java: 'code', kt: 'code', swift: 'code', c: 'code',
  cpp: 'code', h: 'code', hpp: 'code', cs: 'code',
  php: 'code', lua: 'code', sh: 'code', bash: 'code',
  zsh: 'code', fish: 'code', pl: 'code', r: 'code',
  scala: 'code', clj: 'code', ex: 'code', exs: 'code',
  erl: 'code', hs: 'code', elm: 'code', vue: 'code',
  svelte: 'code', html: 'code', css: 'code', scss: 'code',
  less: 'code', sql: 'code', graphql: 'code', gql: 'code',
  // Config
  json: 'json', yaml: 'yml', yml: 'yml', toml: 'config',
  ini: 'config', env: 'config', xml: 'config', lock: 'config',
  // Table
  csv: 'table', tsv: 'table', xls: 'table', xlsx: 'table',
  // Image
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  svg: 'image', webp: 'image', ico: 'image', bmp: 'image',
  // Markdown
  md: 'markdown', mdx: 'markdown'
}

const ICON_COMPONENTS: Record<IconType, typeof DocumentIcon> = {
  folder: FolderIcon,
  code: CodeBracketIcon,
  config: Cog6ToothIcon,
  image: PhotoIcon,
  markdown: DocumentTextIcon,
  table: TableCellsIcon,
  license: KeyIcon,
  gitignore: XCircleIcon,
  json: CodeBracketSquareIcon,
  yml: Bars3BottomRightIcon,
  readme: InformationCircleIcon,
  noExt: Bars3CenterLeftIcon,
  generic: DocumentIcon
}

function resolveIconType(name: string): IconType {
  if (name in FILENAME_MAP) return FILENAME_MAP[name]
  if (!name.includes('.')) return 'noExt'
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MAP[ext] ?? 'generic'
}

export function FileIcon({
  name,
  isDirectory,
  isOpen,
  className
}: {
  name: string
  isDirectory?: boolean
  isOpen?: boolean
  className?: string
}): React.JSX.Element {
  const cls = `w-3.5 h-3.5 ${className ?? ''}`
  if (isDirectory) return isOpen ? <FolderOpenIcon className={cls} /> : <FolderIcon className={cls} />
  const Component = ICON_COMPONENTS[resolveIconType(name)]
  return <Component className={cls} />
}
