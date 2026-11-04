import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  BellRing,
  ChevronRight,
  ClipboardPaste,
  Clock,
  Combine,
  Copy,
  Download,
  Eye,
  File as FileIcon,
  FileArchive,
  FileDown,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitCompare,
  HardDrive,
  History,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  RotateCw,
  Save,
  Search,
  Table2,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import PageShell from './PageShell'
import type {
  OrvexDiffResult,
  OrvexFileBackup,
  OrvexFileDuplicates,
  OrvexFileEntry,
  OrvexFileListing,
  OrvexFileMeta,
  OrvexFileRoot,
  OrvexFileSearch,
  OrvexFileVersion,
  OrvexFileWatchEvent,
  OrvexFileWatchStatus,
  OrvexPdfInfo,
  OrvexXlsxRead,
  OrvexZipEntry,
} from '../types/desktop'

type Props = { onBack: () => void; notify: (msg: string) => void }

type Tool = 'duplicates' | 'archive' | 'pdf' | 'sheets' | 'doc' | 'diff' | 'history' | 'watch'
type SortKey = 'name' | 'size' | 'modified'

const bridge = typeof window !== 'undefined' ? window.orvex : undefined
const filesApi = bridge?.files

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])
const SHEET_EXT = new Set(['xlsx', 'xls'])

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

function formatDate(ts: number) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function joinPath(dir: string, name: string) {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

function splitPath(p: string) {
  const winDrive = /^([A-Za-z]:)[\\/]/.exec(p)
  const rest = winDrive ? p.slice(winDrive[0].length) : p.replace(/^[\\/]/, '')
  const parts = rest.split(/[\\/]/).filter(Boolean)
  const out: { label: string; path: string }[] = []
  if (winDrive) {
    out.push({ label: `${winDrive[1]}\\`, path: `${winDrive[1]}\\` })
    let acc = `${winDrive[1]}\\`
    for (const part of parts) {
      acc = acc.endsWith('\\') ? `${acc}${part}` : `${acc}\\${part}`
      out.push({ label: part, path: acc })
    }
  } else {
    const rooted = p.startsWith('/')
    let acc = rooted ? '/' : ''
    for (const part of parts) {
      acc = acc === '/' ? `/${part}` : acc ? `${acc}/${part}` : part
      out.push({ label: part, path: acc })
    }
  }
  return out
}

function iconFor(entry: OrvexFileEntry) {
  if (entry.isDir) return <Folder size={15} />
  if (IMAGE_EXT.has(entry.ext)) return <ImageIcon size={15} />
  if (SHEET_EXT.has(entry.ext)) return <FileSpreadsheet size={15} />
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(entry.ext)) return <FileArchive size={15} />
  if (['pdf', 'docx', 'doc', 'md', 'txt'].includes(entry.ext)) return <FileText size={15} />
  return <FileIcon size={15} />
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell.replace(/\r$/, ''))
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''))
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0))
}

export default function FilesPage({ onBack, notify }: Props) {
  const [roots, setRoots] = useState<OrvexFileRoot[]>([])
  const [pathInput, setPathInput] = useState('')
  const [listing, setListing] = useState<OrvexFileListing | null>(null)
  const [selected, setSelected] = useState<OrvexFileEntry | null>(null)
  const [meta, setMeta] = useState<OrvexFileMeta | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [searchRes, setSearchRes] = useState<OrvexFileSearch | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [creating, setCreating] = useState<'folder' | 'file' | null>(null)
  const [createName, setCreateName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [clipboard, setClipboard] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('duplicates')
  const [dupes, setDupes] = useState<OrvexFileDuplicates | null>(null)
  const [zipContents, setZipContents] = useState<{ path: string; entries: OrvexZipEntry[] } | null>(null)
  const [pdfInfo, setPdfInfo] = useState<OrvexPdfInfo | null>(null)
  const [pdfRanges, setPdfRanges] = useState('1')
  const [pdfDegrees, setPdfDegrees] = useState(90)
  const [pdfTitle, setPdfTitle] = useState('')
  const [pdfAuthor, setPdfAuthor] = useState('')
  const [pdfSubject, setPdfSubject] = useState('')
  const [pdfDraftTitle, setPdfDraftTitle] = useState('')
  const [pdfDraftText, setPdfDraftText] = useState('# New document\n\nWrite the content here.')
  const [sheet, setSheet] = useState<OrvexXlsxRead | null>(null)
  const [sheetName, setSheetName] = useState('')
  const [csvText, setCsvText] = useState('Name,Value\nAlpha,1\nBeta,2')
  const [docMarkdown, setDocMarkdown] = useState('# Document\n\n- Point one\n- Point two\n\n| Key | Value |\n| --- | --- |\n| a | 1 |')
  const [diffA, setDiffA] = useState('')
  const [diffB, setDiffB] = useState('')
  const [diffResult, setDiffResult] = useState<OrvexDiffResult | null>(null)
  const [versions, setVersions] = useState<OrvexFileVersion[]>([])
  const [backups, setBackups] = useState<OrvexFileBackup[]>([])
  const [watchStatus, setWatchStatus] = useState<OrvexFileWatchStatus | null>(null)
  const [events, setEvents] = useState<OrvexFileWatchEvent[]>([])
  const requestSeq = useRef(0)

  const fail = useCallback(
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      notify(message)
    },
    [notify],
  )

  const call = useCallback(async <T,>(promise: Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<T> => {
    const result = await promise
    if (!result.ok) throw new Error(result.error)
    return result.data
  }, [])

  const refreshWatch = useCallback(async () => {
    if (!filesApi) return
    const res = await filesApi.watchStatus()
    if (res.ok) setWatchStatus(res.data)
  }, [])

  useEffect(() => {
    if (!filesApi) return
    filesApi
      .roots()
      .then((res) => {
        if (res.ok) setRoots(res.data)
      })
      .catch(() => {})
    void refreshWatch()
    const off = filesApi.onChange((event) => {
      setEvents((prev) => [event, ...prev].slice(0, 100))
      void refreshWatch()
    })
    return () => {
      off()
    }
  }, [refreshWatch])

  const openDir = useCallback(
    async (dir: string) => {
      if (!filesApi) return
      const seq = ++requestSeq.current
      setBusy(true)
      setError('')
      try {
        const data = await call(filesApi.list(dir))
        if (seq !== requestSeq.current) return
        setListing(data)
        setQuery('')
        setSearchRes(null)
        setSelected(null)
        setMeta(null)
        setRenaming(false)
        setConfirmDelete(false)
        setCreating(null)
        setZipContents(null)
        setPdfInfo(null)
        setSheet(null)
        setDupes(null)
        setDiffResult(null)
        setVersions([])
        setBackups([])
        setDocMarkdown(`# ${data.name}\n\n`)
        void refreshWatch()
      } catch (err) {
        fail(err)
      } finally {
        setBusy(false)
      }
    },
    [call, fail, refreshWatch],
  )

  const refresh = useCallback(async () => {
    if (!listing) return
    if (searchRes && query.trim()) {
      try {
        const data = await call(filesApi!.search(listing.path, query.trim()))
        setSearchRes(data)
      } catch (err) {
        fail(err)
      }
      return
    }
    try {
      const data = await call(filesApi!.list(listing.path))
      setListing(data)
      if (selected) {
        const still = data.entries.find((e) => e.path === selected.path)
        if (still) setSelected(still)
        else {
          setSelected(null)
          setMeta(null)
        }
      }
    } catch (err) {
      fail(err)
    }
  }, [call, fail, listing, query, searchRes, selected])

  const selectEntry = useCallback(
    async (entry: OrvexFileEntry) => {
      setSelected(entry)
      setMeta(null)
      setRenaming(false)
      setConfirmDelete(false)
      setVersions([])
      setBackups([])
      setPdfInfo(null)
      setSheet(null)
      if (entry.isDir || !filesApi) return
      try {
        const [info, vers, baks] = await Promise.all([
          call(filesApi.stat(entry.path)),
          call(filesApi.versions(entry.path)),
          call(filesApi.backups(entry.path)),
        ])
        setMeta(info)
        setVersions(vers)
        setBackups(baks)
        if (info.preview?.kind === 'text') setDocMarkdown(info.preview.text || docMarkdown)
      } catch (err) {
        fail(err)
      }
    },
    [call, docMarkdown, fail],
  )

  const runSearch = async () => {
    if (!filesApi || !listing) return
    const text = query.trim()
    if (!text) {
      setSearchRes(null)
      return
    }
    setBusy(true)
    setError('')
    try {
      const data = await call(filesApi.search(listing.path, text))
      setSearchRes(data)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const openSelected = async () => {
    if (!filesApi || !selected) return
    if (selected.isDir) {
      await openDir(selected.path)
      return
    }
    try {
      await call(filesApi.openPath(selected.path))
    } catch (err) {
      fail(err)
    }
  }

  const revealSelected = async () => {
    if (!filesApi || !selected) return
    try {
      await call(filesApi.reveal(selected.path))
    } catch (err) {
      fail(err)
    }
  }

  const createEntry = async () => {
    if (!filesApi || !listing) return
    const name = createName.trim()
    if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
      notify('Pick a plain name without slashes.')
      return
    }
    setBusy(true)
    try {
      const target = joinPath(listing.path, name)
      if (creating === 'folder') {
        await call(filesApi.mkdir(target))
      } else {
        await call(filesApi.write(target, ''))
      }
      setCreating(null)
      setCreateName('')
      await refresh()
      notify(creating === 'folder' ? 'Folder created.' : 'File created.')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const copySelected = () => {
    if (!selected || selected.isDir) return
    setClipboard(selected.path)
    notify('Copied — open a folder and use Paste.')
  }

  const pasteClipboard = async () => {
    if (!filesApi || !listing || !clipboard) return
    setBusy(true)
    setError('')
    try {
      const base = clipboard.split(/[\\/]/).pop() || 'copy'
      const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : ''
      const stem = ext ? base.slice(0, -ext.length) : base
      let name = `${stem} (copy)${ext}`
      let target = joinPath(listing.path, name)
      let n = 2
      while (listing.entries.some((entry) => entry.path.toLowerCase() === target.toLowerCase())) {
        name = `${stem} (copy ${n})${ext}`
        target = joinPath(listing.path, name)
        n += 1
      }
      await call(filesApi.copy(clipboard, target))
      notify(`Pasted ${name}.`)
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const saveRename = async () => {
    if (!filesApi || !selected) return
    const name = renameValue.trim()
    if (!name || /[\\/:*?"<>|]/.test(name)) {
      notify('Pick a plain file name.')
      return
    }
    if (name === selected.name) {
      setRenaming(false)
      return
    }
    setBusy(true)
    try {
      const parent = listing ? listing.path : selected.path.slice(0, selected.path.length - selected.name.length).replace(/[\\/]$/, '')
      const updated = await call(filesApi.rename(selected.path, joinPath(parent, name)))
      setRenaming(false)
      await refresh()
      setSelected({ ...selected, name: updated.name, path: updated.path })
      notify('Renamed.')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const deleteSelected = async () => {
    if (!filesApi || !selected) return
    setBusy(true)
    try {
      await call(filesApi.remove(selected.path, selected.isDir))
      setConfirmDelete(false)
      setSelected(null)
      setMeta(null)
      setVersions([])
      setBackups([])
      await refresh()
      notify('Deleted.')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const backUpSelected = async () => {
    if (!filesApi || !selected || selected.isDir) return
    setBusy(true)
    try {
      const record = await call(filesApi.backup(selected.path))
      const list = await call(filesApi.backups(selected.path))
      setBackups(list)
      notify(`Backed up (${formatBytes(record.bytes)}).`)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const restoreBackup = async (id: string) => {
    if (!filesApi) return
    setBusy(true)
    try {
      const info = await call(filesApi.restoreBackup(id))
      setMeta(info)
      await refresh()
      notify('Backup restored.')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const removeBackup = async (id: string) => {
    if (!filesApi) return
    setBusy(true)
    try {
      await call(filesApi.removeBackup(id))
      if (selected) setBackups(await call(filesApi.backups(selected.path)))
      notify('Backup deleted.')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const restoreVersion = async (id: string) => {
    if (!filesApi) return
    setBusy(true)
    try {
      const info = await call(filesApi.restoreVersion(id))
      setMeta(info)
      if (selected) setVersions(await call(filesApi.versions(selected.path)))
      await refresh()
      notify('Version restored.')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const pickSave = async (suggested: string, filters: { name: string; extensions: string[] }[]) => {
    if (!filesApi || !listing) return null
    const result = await call(filesApi.pickSave(joinPath(listing.path, suggested), filters))
    return result.cancelled ? null : result.path
  }

  const pickFile = async (filters: { name: string; extensions: string[] }[]) => {
    if (!filesApi) return null
    const result = await call(filesApi.pickFile(filters))
    return result.cancelled ? null : result.path
  }

  const pickFolder = async () => {
    if (!filesApi) return null
    const result = await call(filesApi.pickFolder())
    return result.cancelled ? null : result.path
  }

  const scanDuplicates = async () => {
    if (!filesApi || !listing) return
    setBusy(true)
    setError('')
    try {
      setDupes(await call(filesApi.duplicates(listing.path)))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const zipFolder = async () => {
    if (!filesApi || !listing) return
    try {
      const dest = await pickSave(`${listing.name || 'archive'}.zip`, [{ name: 'Zip archive', extensions: ['zip'] }])
      if (!dest) return
      setBusy(true)
      const result = await call(filesApi.zip(dest, [listing.path]))
      notify(`Zipped ${result.entries} entries.`)
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const zipSelected = async () => {
    if (!filesApi || !selected) return
    try {
      const dest = await pickSave(`${selected.name.replace(/\.[^.]+$/, '')}.zip`, [{ name: 'Zip archive', extensions: ['zip'] }])
      if (!dest) return
      setBusy(true)
      const result = await call(filesApi.zip(dest, [selected.path]))
      notify(`Zipped ${result.entries} entries.`)
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const unzipInto = async () => {
    if (!filesApi || !listing) return
    try {
      const zipPath = await pickFile([{ name: 'Zip archive', extensions: ['zip'] }])
      if (!zipPath) return
      const destDir = await pickFolder()
      if (!destDir) return
      setBusy(true)
      const result = await call(filesApi.unzip(zipPath, destDir))
      notify(`Extracted ${result.extracted} files.`)
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const loadZipContents = async () => {
    if (!filesApi || !selected || selected.ext !== 'zip') return
    try {
      setZipContents(await call(filesApi.zipList(selected.path)))
    } catch (err) {
      fail(err)
    }
  }

  const loadPdfInfo = async () => {
    if (!filesApi || !selected || selected.ext !== 'pdf') return
    try {
      const info = await call(filesApi.pdfInfo(selected.path))
      setPdfInfo(info)
      setPdfTitle(info.title)
      setPdfAuthor(info.author)
      setPdfSubject(info.subject)
    } catch (err) {
      fail(err)
    }
  }

  const mergePdf = async () => {
    if (!filesApi || !selected || selected.ext !== 'pdf') return
    try {
      const other = await pickFile([{ name: 'PDF', extensions: ['pdf'] }])
      if (!other) return
      const dest = await pickSave(`${selected.name.replace(/\.pdf$/i, '')}-merged.pdf`, [{ name: 'PDF', extensions: ['pdf'] }])
      if (!dest) return
      setBusy(true)
      const info = await call(filesApi.pdfMerge([selected.path, other], dest))
      setPdfInfo(info)
      notify(`Merged into ${info.pages} pages.`)
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const splitPdf = async () => {
    if (!filesApi || !selected || selected.ext !== 'pdf') return
    try {
      const destDir = await pickFolder()
      if (!destDir) return
      setBusy(true)
      const result = await call(filesApi.pdfSplit(selected.path, pdfRanges, destDir))
      notify(`Created ${result.created.length} PDF${result.created.length === 1 ? '' : 's'}.`)
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const rotatePdf = async () => {
    if (!filesApi || !selected || selected.ext !== 'pdf') return
    try {
      const dest = await pickSave(`${selected.name.replace(/\.pdf$/i, '')}-rotated.pdf`, [{ name: 'PDF', extensions: ['pdf'] }])
      if (!dest) return
      setBusy(true)
      const info = await call(filesApi.pdfRotate(selected.path, '', pdfDegrees, dest))
      setPdfInfo(info)
      notify(`Rotated ${pdfDegrees}°.`)
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const savePdfMeta = async () => {
    if (!filesApi || !selected || selected.ext !== 'pdf') return
    try {
      const dest = await pickSave(`${selected.name.replace(/\.pdf$/i, '')}-meta.pdf`, [{ name: 'PDF', extensions: ['pdf'] }])
      if (!dest) return
      setBusy(true)
      const info = await call(
        filesApi.pdfSetMeta(selected.path, { title: pdfTitle, author: pdfAuthor, subject: pdfSubject }, dest),
      )
      setPdfInfo(info)
      notify('PDF metadata saved.')
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const createPdf = async () => {
    if (!filesApi) return
    try {
      const dest = await pickSave('document.pdf', [{ name: 'PDF', extensions: ['pdf'] }])
      if (!dest) return
      setBusy(true)
      const info = await call(filesApi.pdfCreate(dest, pdfDraftTitle || 'ORVEX document', pdfDraftText))
      notify(`PDF created (${info.pages} page${info.pages === 1 ? '' : 's'}).`)
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const loadSheet = async (name?: string) => {
    if (!filesApi || !selected || !SHEET_EXT.has(selected.ext)) return
    setBusy(true)
    try {
      const data = await call(filesApi.xlsxRead(selected.path, name || sheetName || undefined))
      setSheet(data)
      setSheetName(data.sheet)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const exportSheetCsv = async () => {
    if (!filesApi || !selected || !SHEET_EXT.has(selected.ext)) return
    try {
      const dest = await pickSave(`${selected.name.replace(/\.[^.]+$/, '')}.csv`, [{ name: 'CSV', extensions: ['csv'] }])
      if (!dest) return
      setBusy(true)
      await call(filesApi.xlsxToCsv(selected.path, dest, sheet?.sheet))
      notify('Sheet exported to CSV.')
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const createWorkbook = async () => {
    if (!filesApi) return
    const rows = parseCsv(csvText)
    if (!rows.length) {
      notify('Write some CSV rows first.')
      return
    }
    try {
      const dest = await pickSave('workbook.xlsx', [{ name: 'Excel workbook', extensions: ['xlsx'] }])
      if (!dest) return
      setBusy(true)
      const info = await call(filesApi.xlsxWrite(dest, [{ name: 'Sheet1', rows }]))
      notify(`Workbook created (${info.sheets.length} sheet).`)
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const loadTextIntoDoc = async () => {
    if (!filesApi || !selected || meta?.preview?.kind !== 'text') {
      notify('Select a text file first.')
      return
    }
    try {
      const data = await call(filesApi.read(selected.path))
      setDocMarkdown(data.text)
      notify('Loaded into the document draft.')
    } catch (err) {
      fail(err)
    }
  }

  const createDocx = async () => {
    if (!filesApi) return
    if (!docMarkdown.trim()) {
      notify('Write some content first.')
      return
    }
    try {
      const dest = await pickSave('document.docx', [{ name: 'Word document', extensions: ['docx'] }])
      if (!dest) return
      setBusy(true)
      const result = await call(filesApi.docxMake(dest, docMarkdown))
      notify(`Word document created (${result.bytes} bytes).`)
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const runDiff = async () => {
    if (!filesApi || !diffA.trim() || !diffB.trim()) {
      notify('Pick two text files to compare.')
      return
    }
    setBusy(true)
    try {
      setDiffResult(await call(filesApi.diff(diffA.trim(), diffB.trim())))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const toggleWatch = async () => {
    if (!filesApi || !listing) return
    setBusy(true)
    try {
      const active = watchStatus?.watching.find((w) => w.path.toLowerCase() === listing.path.toLowerCase())
      if (active) {
        await call(filesApi.watchStop(active.id))
        notify('Stopped watching.')
      } else {
        await call(filesApi.watchStart(listing.path))
        notify('Watching this folder for changes.')
      }
      await refreshWatch()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const display = useMemo(() => {
    const source = searchRes ? searchRes.results : listing?.entries ?? []
    const sorted = [...source].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      let cmp = 0
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      else if (sortKey === 'size') cmp = a.size - b.size
      else cmp = a.modifiedAt - b.modifiedAt
      return sortAsc ? cmp : -cmp
    })
    return sorted
  }, [listing, searchRes, sortAsc, sortKey])

  const visible = display.slice(0, 500)
  const crumbs = listing ? splitPath(listing.path) : []
  const activeWatch = listing
    ? watchStatus?.watching.find((w) => w.path.toLowerCase() === listing.path.toLowerCase())
    : undefined
  const folderPrefix = listing ? `${listing.path}${listing.path.includes('\\') ? '\\' : '/'}`.toLowerCase() : ''
  const folderEvents = events.filter((e) => {
    const p = e.path.toLowerCase()
    return listing ? p === listing.path.toLowerCase() || p.startsWith(folderPrefix) : false
  })

  const sortBy = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v)
    else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  return (
    <PageShell
      title="Files"
      sub="Real files on this PC — browse, inspect, archive, convert and restore"
      onBack={onBack}
      actions={
        <>
          <button
            className="page-tool-btn"
            onClick={() => {
              void pickFolder()
                .then((dir) => {
                  if (dir) void openDir(dir)
                })
                .catch(fail)
            }}
            title="Open folder"
            aria-label="Open folder"
            disabled={!filesApi}
          >
            <FolderOpen size={14} />
          </button>
          <button className="page-tool-btn" onClick={() => void refresh()} title="Refresh" aria-label="Refresh" disabled={!listing || busy}>
            <RefreshCw size={14} />
          </button>
        </>
      }
    >
      {!filesApi && (
        <div className="fm-banner">
          <AlertTriangle size={14} />
          <div>
            <strong>Browser mode.</strong> The Files workspace reads real folders through the desktop app. Run <code>npm run desktop:dev</code>.
          </div>
        </div>
      )}

      <div className="fm-page">
        {error && (
          <div className="fm-error">
            <AlertTriangle size={13} />
            <span>{error}</span>
            <button onClick={() => setError('')} aria-label="Dismiss error">
              <X size={12} />
            </button>
          </div>
        )}

        {!listing ? (
          <div className="fm-landing">
            <div className="fm-landing-head">
              <HardDrive size={20} />
              <div>
                <h3>Open a place on this PC</h3>
                <p className="dim">Quick access uses your real home folders. System folders and credential stores stay blocked.</p>
              </div>
            </div>
            <div className="fm-roots">
              {roots.map((root) => (
                <button key={root.path} className="fm-root" onClick={() => void openDir(root.path)} title={root.path}>
                  <Folder size={18} />
                  <span>{root.label}</span>
                  <small>{root.path}</small>
                </button>
              ))}
              <button
                className="fm-root fm-root-pick"
                onClick={() => {
                  void pickFolder()
                    .then((dir) => {
                      if (dir) void openDir(dir)
                    })
                    .catch(fail)
                }}
              >
                <FolderOpen size={18} />
                <span>Choose a folder…</span>
                <small>Any folder outside system paths</small>
              </button>
            </div>
            <div className="fm-pathbar">
              <input
                className="text-input fm-path-input"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && pathInput.trim()) void openDir(pathInput.trim())
                }}
                placeholder="C:\Users\you\Documents"
                aria-label="Open path"
              />
              <button className="btn-primary" onClick={() => pathInput.trim() && void openDir(pathInput.trim())} disabled={!pathInput.trim()}>
                Go
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="fm-toolbar">
              <button className="fm-icon-btn" onClick={() => listing.parent && void openDir(listing.parent)} disabled={!listing.parent} title="Up one folder" aria-label="Up one folder">
                <ArrowUp size={13} />
              </button>
              <div className="fm-crumbs">
                {crumbs.map((crumb, i) => (
                  <span key={crumb.path} className="fm-crumb-group">
                    {i > 0 && <ChevronRight size={10} />}
                    <button className="fm-crumb" onClick={() => void openDir(crumb.path)}>
                      {crumb.label}
                    </button>
                  </span>
                ))}
              </div>
              <div className="fm-search">
                <Search size={12} />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    if (!e.target.value.trim()) setSearchRes(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void runSearch()
                  }}
                  placeholder="Find in this folder…"
                  aria-label="Find in this folder"
                />
                {query && (
                  <button onClick={() => { setQuery(''); setSearchRes(null) }} aria-label="Clear search">
                    <X size={11} />
                  </button>
                )}
              </div>
              <button className="fm-icon-btn" onClick={() => void runSearch()} title="Search" aria-label="Search folder">
                <Search size={13} />
              </button>
              <button
                className="fm-icon-btn"
                onClick={() => {
                  setCreating('folder')
                  setCreateName('')
                }}
                title="New folder"
                aria-label="New folder"
              >
                <FolderPlus size={14} />
              </button>
              <button
                className="fm-icon-btn"
                onClick={() => {
                  setCreating('file')
                  setCreateName('')
                }}
                title="New file"
                aria-label="New file"
              >
                <FilePlus2 size={14} />
              </button>
              <button
                className="fm-icon-btn"
                onClick={() => void pasteClipboard()}
                title={clipboard ? 'Paste copied file here' : 'Copy a file first'}
                aria-label="Paste copied file"
                disabled={!clipboard || busy}
              >
                <ClipboardPaste size={14} />
              </button>
              <button className={`fm-icon-btn ${activeWatch ? 'active' : ''}`} onClick={() => void toggleWatch()} title={activeWatch ? 'Stop watching' : 'Watch for changes'} aria-label="Toggle folder watcher">
                <BellRing size={13} />
              </button>
              {busy && <Loader2 size={13} className="spin fm-busy" />}
            </div>

            {creating && (
              <div className="fm-newbar">
                <span>{creating === 'folder' ? 'New folder name' : 'New file name'}</span>
                <input
                  className="text-input"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createEntry()
                    if (e.key === 'Escape') setCreating(null)
                  }}
                  placeholder={creating === 'folder' ? 'Reports' : 'notes.txt'}
                  aria-label="New entry name"
                  autoFocus
                />
                <button className="btn-primary" onClick={() => void createEntry()} disabled={busy || !createName.trim()}>
                  Create
                </button>
                <button className="btn-ghost" onClick={() => setCreating(null)}>
                  Cancel
                </button>
              </div>
            )}

            {searchRes && (
              <div className="fm-search-note">
                {searchRes.results.length} match{searchRes.results.length === 1 ? '' : 'es'} for “{searchRes.query}” · scanned {searchRes.scanned}
                {searchRes.truncated ? ' · capped' : ''}
                <button className="fm-link" onClick={() => { setSearchRes(null); setQuery('') }}>
                  Clear
                </button>
              </div>
            )}

            <div className="fm-layout">
              <section className="panel fm-list-panel">
                <div className="fm-table">
                  <div className="fm-table-head">
                    <button className="fm-th" onClick={() => sortBy('name')}>
                      Name {sortKey === 'name' ? (sortAsc ? '↑' : '↓') : ''}
                    </button>
                    <button className="fm-th" onClick={() => sortBy('size')}>
                      Size {sortKey === 'size' ? (sortAsc ? '↑' : '↓') : ''}
                    </button>
                    <button className="fm-th" onClick={() => sortBy('modified')}>
                      Modified {sortKey === 'modified' ? (sortAsc ? '↑' : '↓') : ''}
                    </button>
                  </div>
                  <div className="fm-rows">
                    {display.length === 0 && <p className="dim fm-empty">{searchRes ? 'No files matched that search.' : 'This folder is empty.'}</p>}
                    {visible.map((entry) => (
                      <button
                        key={entry.path}
                        className={`fm-row ${selected?.path === entry.path ? 'selected' : ''}`}
                        onClick={() => void selectEntry(entry)}
                        onDoubleClick={() => (entry.isDir ? void openDir(entry.path) : void (filesApi && call(filesApi.openPath(entry.path)).catch(fail)))}
                        title={entry.path}
                      >
                        <span className={`fm-name ${entry.hidden ? 'dim' : ''}`}>
                          {iconFor(entry)}
                          <span>{entry.name}</span>
                        </span>
                        <span className="fm-size">{entry.isDir ? '—' : formatBytes(entry.size)}</span>
                        <span className="fm-date">{formatDate(entry.modifiedAt)}</span>
                      </button>
                    ))}
                    {display.length > visible.length && (
                      <p className="dim fm-empty">Showing the first {visible.length} of {display.length} entries — narrow the folder or search.</p>
                    )}
                  </div>
                </div>
              </section>

              <section className="panel fm-detail">
                {!selected ? (
                  <div className="fm-detail-empty">
                    <FileIcon size={26} />
                    <p>Select a file to inspect it, or double-click a folder to open it.</p>
                  </div>
                ) : (
                  <>
                    <div className="fm-detail-head">
                      <span className="fm-detail-icon">{iconFor(selected)}</span>
                      {renaming ? (
                        <div className="fm-rename">
                          <input
                            className="text-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void saveRename()
                              if (e.key === 'Escape') setRenaming(false)
                            }}
                            aria-label="New name"
                            autoFocus
                          />
                          <button className="btn-primary" onClick={() => void saveRename()} disabled={busy}>
                            Save
                          </button>
                          <button className="btn-ghost" onClick={() => setRenaming(false)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="fm-title">
                          <strong>{selected.name}</strong>
                          <span className="dim">{selected.isDir ? 'Folder' : meta?.mime || selected.ext || 'file'}</span>
                        </div>
                      )}
                    </div>

                    <div className="fm-actions">
                      <button className="btn-ghost" onClick={() => void openSelected()} disabled={busy}>
                        <FolderOpen size={12} /> {selected.isDir ? 'Open' : 'Open with app'}
                      </button>
                      <button className="btn-ghost" onClick={() => void revealSelected()} disabled={busy}>
                        <Eye size={12} /> Show in Explorer
                      </button>
                      <button className="btn-ghost" onClick={copySelected} disabled={busy || selected.isDir} title="Copy this file, then paste it into any folder">
                        <Copy size={12} /> Copy
                      </button>
                      <button
                        className="btn-ghost"
                        onClick={() => {
                          setRenameValue(selected.name)
                          setRenaming(true)
                        }}
                        disabled={busy}
                      >
                        Rename
                      </button>
                      {confirmDelete ? (
                        <>
                          <button className="btn-danger" onClick={() => void deleteSelected()} disabled={busy}>
                            Confirm delete
                          </button>
                          <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="btn-ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
                          <Trash2 size={12} /> Delete
                        </button>
                      )}
                    </div>

                    {meta && (
                      <div className="fm-meta">
                        <div>
                          <span>Size</span>
                          <b>{formatBytes(meta.size)}</b>
                        </div>
                        <div>
                          <span>Created</span>
                          <b>{formatDate(meta.createdAt)}</b>
                        </div>
                        <div>
                          <span>Modified</span>
                          <b>{formatDate(meta.modifiedAt)}</b>
                        </div>
                        <div>
                          <span>Mode</span>
                          <b>{meta.mode}</b>
                        </div>
                        <div className="fm-meta-wide">
                          <span>SHA-256 {meta.hashPartial ? '(head+tail)' : ''}</span>
                          <b>{meta.sha256 || '—'}</b>
                        </div>
                        <div className="fm-meta-wide">
                          <span>Path</span>
                          <b>{meta.path}</b>
                        </div>
                      </div>
                    )}

                    {meta?.preview && (
                      <div className="fm-preview">
                        {meta.preview.kind === 'image' && <img src={meta.preview.dataUrl} alt={meta.name} />}
                        {meta.preview.kind === 'text' && <pre>{meta.preview.text}</pre>}
                        {meta.preview.kind === 'pdf' && (
                          <div className="fm-preview-note">
                            <FileText size={14} /> PDF document — use the PDF toolkit to read pages, split, merge or rotate.
                          </div>
                        )}
                        {meta.preview.kind === 'binary' && (
                          <div className="fm-preview-note">
                            <FileIcon size={14} /> No inline preview for this file type.
                          </div>
                        )}
                      </div>
                    )}

                    {selected.isDir && <div className="fm-preview-note">Folder — open it to see contents.</div>}
                  </>
                )}
              </section>
            </div>

            <section className="panel fm-tools">
              <div className="fm-tool-tabs">
                <button className={tool === 'duplicates' ? 'active' : ''} onClick={() => setTool('duplicates')}>
                  <Search size={12} /> Duplicates
                </button>
                <button className={tool === 'archive' ? 'active' : ''} onClick={() => setTool('archive')}>
                  <FileArchive size={12} /> Archive
                </button>
                <button className={tool === 'pdf' ? 'active' : ''} onClick={() => setTool('pdf')}>
                  <FileText size={12} /> PDF
                </button>
                <button className={tool === 'sheets' ? 'active' : ''} onClick={() => setTool('sheets')}>
                  <Table2 size={12} /> Sheets
                </button>
                <button className={tool === 'doc' ? 'active' : ''} onClick={() => setTool('doc')}>
                  <FileDown size={12} /> Word
                </button>
                <button className={tool === 'diff' ? 'active' : ''} onClick={() => setTool('diff')}>
                  <GitCompare size={12} /> Diff
                </button>
                <button className={tool === 'history' ? 'active' : ''} onClick={() => setTool('history')}>
                  <History size={12} /> Versions
                </button>
                <button className={tool === 'watch' ? 'active' : ''} onClick={() => setTool('watch')}>
                  <BellRing size={12} /> Watcher
                </button>
              </div>

              {tool === 'duplicates' && (
                <div className="fm-tool-panel fm-tool-duplicates">
                  <div className="fm-tool-row">
                    <button className="btn-primary" onClick={() => void scanDuplicates()} disabled={busy}>
                      <Wrench size={12} /> Scan this folder for duplicates
                    </button>
                    {dupes && (
                      <span className="dim">
                        {dupes.scanned} files · {dupes.groups.length} group{dupes.groups.length === 1 ? '' : 's'} · {formatBytes(dupes.wasted)} wasted · {dupes.tookMs} ms
                      </span>
                    )}
                  </div>
                  {dupes && dupes.groups.length === 0 && <p className="dim">No duplicate files found.</p>}
                  {dupes?.groups.map((group) => (
                    <div key={group.sha256} className="fm-dup-group">
                      <div className="fm-dup-head">
                        <span>{formatBytes(group.size)} × {group.files.length}</span>
                        <span className="dim">saves {formatBytes(group.wasted)} · {group.sha256.slice(0, 12)}…</span>
                      </div>
                      {group.files.map((file) => (
                        <div key={file.path} className="fm-dup-file">
                          <span title={file.path}>{file.path}</span>
                          <button
                            className="fm-link"
                            onClick={() => {
                              if (!filesApi) return
                              void call(filesApi.reveal(file.path)).catch(fail)
                            }}
                          >
                            Show
                          </button>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {tool === 'archive' && (
                <div className="fm-tool-panel fm-tool-archive">
                  <div className="fm-tool-row">
                    <button className="btn-ghost" onClick={() => void zipFolder()} disabled={busy || !listing}>
                      <FileArchive size={12} /> Zip current folder…
                    </button>
                    <button className="btn-ghost" onClick={() => void zipSelected()} disabled={busy || !selected}>
                      Zip selected…
                    </button>
                    <button className="btn-ghost" onClick={() => void unzipInto()} disabled={busy}>
                      Unzip a .zip…
                    </button>
                    <button className="btn-ghost" onClick={() => void loadZipContents()} disabled={!selected || selected.ext !== 'zip'}>
                      List zip contents
                    </button>
                  </div>
                  {zipContents && (
                    <div className="fm-list-box">
                      <div className="dim">{zipContents.entries.length} entries in {zipContents.path}</div>
                      {zipContents.entries.slice(0, 200).map((entry) => (
                        <div key={entry.path} className="fm-zip-row">
                          <span>{entry.isDir ? '📁' : '📄'} {entry.path}</span>
                          <span className="dim">{entry.isDir ? '' : formatBytes(entry.size)}</span>
                        </div>
                      ))}
                      {zipContents.entries.length > 200 && <p className="dim">Showing first 200 entries.</p>}
                    </div>
                  )}
                  {!selected && <p className="dim">Select a file or folder above to zip it or list an existing archive.</p>}
                </div>
              )}

              {tool === 'pdf' && (
                <div className="fm-tool-panel fm-tool-pdf">
                  {selected?.ext === 'pdf' ? (
                    <>
                      <div className="fm-tool-row">
                        <button className="btn-ghost" onClick={() => void loadPdfInfo()} disabled={busy}>
                          <FileText size={12} /> Read info
                        </button>
                        <button className="btn-ghost" onClick={() => void mergePdf()} disabled={busy}>
                          <Combine size={12} /> Merge with another PDF…
                        </button>
                      </div>
                      {pdfInfo && (
                        <div className="fm-inline-grid">
                          <div><span>Pages</span><b>{pdfInfo.pages}</b></div>
                          <div><span>Title</span><b>{pdfInfo.title || '—'}</b></div>
                          <div><span>Author</span><b>{pdfInfo.author || '—'}</b></div>
                          <div><span>Size</span><b>{formatBytes(pdfInfo.bytes)}</b></div>
                        </div>
                      )}
                      <div className="fm-tool-row">
                        <label className="fm-mini-field">
                          <span>Split pages</span>
                          <input className="text-input" value={pdfRanges} onChange={(e) => setPdfRanges(e.target.value)} placeholder="1-2,4" />
                        </label>
                        <button className="btn-ghost" onClick={() => void splitPdf()} disabled={busy}>
                          Split into folder…
                        </button>
                        <label className="fm-mini-field">
                          <span>Rotate</span>
                          <select className="select" value={pdfDegrees} onChange={(e) => setPdfDegrees(Number(e.target.value))}>
                            <option value={90}>90°</option>
                            <option value={180}>180°</option>
                            <option value={270}>270°</option>
                          </select>
                        </label>
                        <button className="btn-ghost" onClick={() => void rotatePdf()} disabled={busy}>
                          <RotateCw size={12} /> Rotate…
                        </button>
                      </div>
                      <div className="fm-tool-row">
                        <input className="text-input" value={pdfTitle} onChange={(e) => setPdfTitle(e.target.value)} placeholder="Title" aria-label="PDF title" />
                        <input className="text-input" value={pdfAuthor} onChange={(e) => setPdfAuthor(e.target.value)} placeholder="Author" aria-label="PDF author" />
                        <input className="text-input" value={pdfSubject} onChange={(e) => setPdfSubject(e.target.value)} placeholder="Subject" aria-label="PDF subject" />
                        <button className="btn-ghost" onClick={() => void savePdfMeta()} disabled={busy}>
                          <Save size={12} /> Save metadata…
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="dim">Select a PDF above to read, split, rotate, merge or set metadata.</p>
                  )}
                  <div className="fm-tool-block">
                    <div className="fm-tool-row">
                      <input className="text-input" value={pdfDraftTitle} onChange={(e) => setPdfDraftTitle(e.target.value)} placeholder="New PDF title" aria-label="New PDF title" />
                      <button className="btn-primary" onClick={() => void createPdf()} disabled={busy}>
                        <FileText size={12} /> Create PDF…
                      </button>
                    </div>
                    <textarea className="fm-textarea" value={pdfDraftText} onChange={(e) => setPdfDraftText(e.target.value)} aria-label="New PDF text" />
                  </div>
                </div>
              )}

              {tool === 'sheets' && (
                <div className="fm-tool-panel fm-tool-sheets">
                  {selected && SHEET_EXT.has(selected.ext) ? (
                    <>
                      <div className="fm-tool-row">
                        <button className="btn-ghost" onClick={() => void loadSheet()} disabled={busy}>
                          <Table2 size={12} /> Load sheet
                        </button>
                        {sheet && (
                          <select className="select" value={sheetName} onChange={(e) => void loadSheet(e.target.value)} aria-label="Sheet">
                            {sheet.sheets.map((name) => (
                              <option key={name} value={name}>{name}</option>
                            ))}
                          </select>
                        )}
                        <button className="btn-ghost" onClick={() => void exportSheetCsv()} disabled={busy}>
                          <Download size={12} /> Export CSV…
                        </button>
                        {sheet && <span className="dim">{sheet.totalRows} rows{sheet.truncated ? ' (preview capped)' : ''}</span>}
                      </div>
                      {sheet && (
                        <div className="fm-sheet">
                          <table>
                            <thead>
                              <tr>{sheet.header.map((cell, i) => <th key={i}>{cell}</th>)}</tr>
                            </thead>
                            <tbody>
                              {sheet.rows.slice(0, 50).map((row, r) => (
                                <tr key={r}>
                                  {sheet.header.map((_, c) => <td key={c}>{row[c] ?? ''}</td>)}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="dim">Select an .xlsx or .xls file to preview sheets and export CSV.</p>
                  )}
                  <div className="fm-tool-block">
                    <div className="fm-tool-row">
                      <span className="dim">Create a workbook from CSV:</span>
                      <button className="btn-primary" onClick={() => void createWorkbook()} disabled={busy}>
                        <FileSpreadsheet size={12} /> Create .xlsx…
                      </button>
                    </div>
                    <textarea className="fm-textarea" value={csvText} onChange={(e) => setCsvText(e.target.value)} aria-label="CSV rows" />
                  </div>
                </div>
              )}

              {tool === 'doc' && (
                <div className="fm-tool-panel fm-tool-doc">
                  <div className="fm-tool-row">
                    <span className="dim">Markdown → Word (.docx). Headings, bullets, quotes and pipe tables are converted.</span>
                    <button className="btn-ghost" onClick={() => void loadTextIntoDoc()} disabled={!selected || meta?.preview?.kind !== 'text'}>
                      Load selected text
                    </button>
                    <button className="btn-primary" onClick={() => void createDocx()} disabled={busy}>
                      <FileDown size={12} /> Create .docx…
                    </button>
                  </div>
                  <textarea className="fm-textarea fm-textarea-tall" value={docMarkdown} onChange={(e) => setDocMarkdown(e.target.value)} aria-label="Document markdown" />
                </div>
              )}

              {tool === 'diff' && (
                <div className="fm-tool-panel fm-tool-diff">
                  <div className="fm-tool-row">
                    <input className="text-input fm-diff-path" value={diffA} onChange={(e) => setDiffA(e.target.value)} placeholder="First file path" aria-label="First file path" />
                    <button className="btn-ghost" onClick={() => void pickFile([{ name: 'Text', extensions: ['txt', 'md', 'json', 'csv', 'log', 'js', 'ts', 'css', 'html'] }]).then((p) => p && setDiffA(p)).catch(fail)}>
                      Browse…
                    </button>
                    <input className="text-input fm-diff-path" value={diffB} onChange={(e) => setDiffB(e.target.value)} placeholder="Second file path" aria-label="Second file path" />
                    <button className="btn-ghost" onClick={() => void pickFile([{ name: 'Text', extensions: ['txt', 'md', 'json', 'csv', 'log', 'js', 'ts', 'css', 'html'] }]).then((p) => p && setDiffB(p)).catch(fail)}>
                      Browse…
                    </button>
                    <button className="btn-primary" onClick={() => void runDiff()} disabled={busy}>
                      <GitCompare size={12} /> Compare
                    </button>
                  </div>
                  {diffResult && (
                    <>
                      <div className="dim">+{diffResult.added} added · −{diffResult.removed} removed · {diffResult.same} unchanged</div>
                      <div className="fm-diff">
                        {diffResult.lines.slice(0, 600).map((line, i) => (
                          <div key={i} className={`fm-diff-line ${line.type}`}>
                            <span>{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
                            <code>{line.text || ' '}</code>
                          </div>
                        ))}
                        {diffResult.lines.length > 600 && <p className="dim">Diff capped at 600 lines.</p>}
                      </div>
                    </>
                  )}
                </div>
              )}

              {tool === 'history' && (
                <div className="fm-tool-panel fm-tool-history">
                  {selected && !selected.isDir ? (
                    <>
                      <div className="fm-tool-row">
                        <button className="btn-primary" onClick={() => void backUpSelected()} disabled={busy}>
                          <Save size={12} /> Back up this file now
                        </button>
                        <span className="dim">{versions.length} versions · {backups.length} backups</span>
                      </div>
                      <div className="fm-history-grid">
                        <div className="fm-history-col">
                          <h4><History size={12} /> Versions</h4>
                          {versions.length === 0 && <p className="dim">No versions yet — ORVEX snapshots before each save, rename or delete.</p>}
                          {versions.map((version) => (
                            <div key={version.id} className="fm-history-row">
                              <div>
                                <b>{formatDate(version.createdAt)}</b>
                                <span className="dim">{version.reason} · {formatBytes(version.bytes)}</span>
                              </div>
                              <button className="fm-link" onClick={() => void restoreVersion(version.id)} disabled={busy}>
                                Restore
                              </button>
                            </div>
                          ))}
                        </div>
                        <div className="fm-history-col">
                          <h4><Clock size={12} /> Backups</h4>
                          {backups.length === 0 && <p className="dim">No backups yet — use the button above before risky edits.</p>}
                          {backups.map((backup) => (
                            <div key={backup.id} className="fm-history-row">
                              <div>
                                <b>{formatDate(backup.createdAt)}</b>
                                <span className="dim">{formatBytes(backup.bytes)}</span>
                              </div>
                              <span className="fm-history-actions">
                                <button className="fm-link" onClick={() => void restoreBackup(backup.id)} disabled={busy}>
                                  Restore
                                </button>
                                <button className="fm-link danger" onClick={() => void removeBackup(backup.id)} disabled={busy}>
                                  Delete
                                </button>
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="dim">Select a file to see its version history and backups.</p>
                  )}
                </div>
              )}

              {tool === 'watch' && (
                <div className="fm-tool-panel fm-tool-watch">
                  <div className="fm-tool-row">
                    <button className="btn-primary" onClick={() => void toggleWatch()} disabled={busy || !listing}>
                      <BellRing size={12} /> {activeWatch ? 'Stop watching this folder' : 'Watch this folder'}
                    </button>
                    {activeWatch && (
                      <span className="dim">watching since {formatDate(activeWatch.startedAt)} · {activeWatch.events} events</span>
                    )}
                  </div>
                  <div className="fm-events">
                    {folderEvents.length === 0 && <p className="dim">Changes in this folder and its subfolders appear here live while the watcher is on.</p>}
                    {folderEvents.map((event, i) => (
                      <div key={`${event.at}-${i}`} className="fm-event">
                        <span className={`fm-event-type ${event.type}`}>{event.type}</span>
                        <span title={event.path}>{event.path}</span>
                        <span className="dim">{new Date(event.at).toLocaleTimeString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </PageShell>
  )
}
