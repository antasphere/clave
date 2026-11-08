import { useEffect, useRef } from 'react'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  type KeyBinding
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { indentUnit, LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { claveEditorTheme } from './code-editor-theme'

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  filename: string
  readOnly?: boolean
  /** Called on Cmd/Ctrl+S while the editor is focused. */
  onSave?: () => void
  /** Put the caret in the editor at mount — a file with nothing in it. */
  autoFocus?: boolean
  className?: string
}

function editableExtension(readOnly: boolean): Extension {
  return [EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]
}

export function CodeEditor({
  value,
  onChange,
  filename,
  readOnly = false,
  onSave,
  autoFocus = false,
  className
}: CodeEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartment = useRef(new Compartment())
  const editableCompartment = useRef(new Compartment())

  // use-latest: keep the freshest callbacks without recreating the editor
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  // Create the editor exactly once
  useEffect(() => {
    const saveKeyBinding: KeyBinding = {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        onSaveRef.current?.()
        return true
      }
    }

    const view = new EditorView({
      parent: containerRef.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          keymap.of([saveKeyBinding, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          claveEditorTheme,
          languageCompartment.current.of([]),
          editableCompartment.current.of(editableExtension(readOnly)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          })
        ]
      })
    })
    viewRef.current = view
    // Read from the creating render, which is the only one that matters: the
    // caret belongs in a file that opened empty, not in one emptied by editing.
    if (autoFocus) view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load language support lazily, keyed on filename
  useEffect(() => {
    let cancelled = false
    const description = LanguageDescription.matchFilename(languages, filename)
    if (!description) {
      viewRef.current?.dispatch({ effects: languageCompartment.current.reconfigure([]) })
      return
    }
    description.load().then((support) => {
      if (cancelled || !viewRef.current) return
      viewRef.current.dispatch({ effects: languageCompartment.current.reconfigure(support) })
    })
    return () => {
      cancelled = true
    }
  }, [filename])

  // Sync external value changes (file switch, save-reload) without clobbering local edits
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  // Reconfigure editability when readOnly flips
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableCompartment.current.reconfigure(editableExtension(readOnly))
    })
  }, [readOnly])

  // flex-col so the CM editor (.cm-editor) can size itself as a flex child —
  // see the `&` rule in code-editor-theme.ts for why height:100% doesn't work.
  return <div ref={containerRef} className={`flex flex-col overflow-hidden ${className ?? ''}`} />
}
