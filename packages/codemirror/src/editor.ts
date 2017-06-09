// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as CodeMirror
  from 'codemirror';

import {
  JSONExt
} from '@phosphor/coreutils';

import {
  ArrayExt
} from '@phosphor/algorithm';

import {
  IDisposable, DisposableDelegate
} from '@phosphor/disposable';

import {
  Signal
} from '@phosphor/signaling';

import {
  CodeEditor
} from '@jupyterlab/codeeditor';

import {
  IObservableMap, IObservableString, uuid, ICollaborator
} from '@jupyterlab/coreutils';

import {
  Mode
} from './mode';

import 'codemirror/addon/edit/matchbrackets.js';
import 'codemirror/addon/edit/closebrackets.js';
import 'codemirror/addon/comment/comment.js';
import 'codemirror/keymap/emacs.js';
import 'codemirror/keymap/sublime.js';
import 'codemirror/keymap/vim.js';


/**
 * The class name added to CodeMirrorWidget instances.
 */
const EDITOR_CLASS = 'jp-CodeMirrorEditor';

/**
 * The class name added to read only cell editor widgets.
 */
const READ_ONLY_CLASS = 'jp-mod-readOnly';

/**
 * The class name for the hover box for collaborator cursors.
 */
const COLLABORATOR_CURSOR_CLASS = 'jp-CollaboratorCursor';

/**
 * The class name for the hover box for collaborator cursors.
 */
const COLLABORATOR_HOVER_CLASS = 'jp-CollaboratorCursor-hover';

/**
 * The key code for the up arrow key.
 */
const UP_ARROW = 38;

/**
 * The key code for the down arrow key.
 */
const DOWN_ARROW = 40;

/**
 * The time that a collaborator name hover persists.
 */
const HOVER_TIMEOUT = 1000;


/**
 * CodeMirror editor.
 */
export
class CodeMirrorEditor implements CodeEditor.IEditor {
  /**
   * Construct a CodeMirror editor.
   */
  constructor(options: CodeMirrorEditor.IOptions) {
    let host = this.host = options.host;
    host.classList.add(EDITOR_CLASS);
    host.addEventListener('focus', this, true);
    host.addEventListener('scroll', this, true);

    this._uuid = options.uuid || uuid();
    this._selectionStyle = options.selectionStyle || {};

    let config = Private.handleOptions(options);

    let model = this._model = options.model;
    let editor = this._editor = CodeMirror(host, config);
    let doc = editor.getDoc();

    // Handle initial values for text, mimetype, and selections.
    doc.setValue(model.value.text);
    this._onMimeTypeChanged();
    this._onCursorActivity();

    // Connect to changes.
    model.value.changed.connect(this._onValueChanged, this);
    model.mimeTypeChanged.connect(this._onMimeTypeChanged, this);
    model.selections.changed.connect(this._onSelectionsChanged, this);

    CodeMirror.on(editor, 'keydown', (editor, event) => {
      let index = ArrayExt.findFirstIndex(this._keydownHandlers, handler => {
        if (handler(this, event) === true) {
          event.preventDefault();
          return true;
        }
      });
      if (index === -1) {
        this.onKeydown(event);
      }
    });
    CodeMirror.on(editor, 'cursorActivity', () => this._onCursorActivity());
    CodeMirror.on(editor.getDoc(), 'beforeChange', (instance, change) => {
      this._beforeDocChanged(instance, change);
    });
    CodeMirror.on(editor.getDoc(), 'change', (instance, change) => {
      // Manually refresh after setValue to make sure editor is properly sized.
      if (change.origin === 'setValue' && this.hasFocus()) {
        this.refresh();
      }
      if (this._model.value.text !== editor.getDoc().getValue()) {
        console.error('Uh oh, the string model is out of sync: ', {
          model: this._model.value.text,
          view: editor.getDoc().getValue()
        });
      }
    });

    // Manually refresh on paste to make sure editor is properly sized.
    editor.getWrapperElement().addEventListener('paste', () => {
      if (this.hasFocus()) {
        this.refresh();
      }
    });
  }

  /**
   * A signal emitted when either the top or bottom edge is requested.
   */
  readonly edgeRequested = new Signal<this, CodeEditor.EdgeLocation>(this);

  /**
   * The DOM node that hosts the editor.
   */
  readonly host: HTMLElement;

  /**
   * The uuid of this editor;
   */
  get uuid(): string {
    return this._uuid;
  }
  set uuid(value: string) {
    this._uuid = value;
  }

  /**
   * The selection style of this editor.
   */
  get selectionStyle(): CodeEditor.ISelectionStyle {
    return this._selectionStyle;
  }
  set selectionStyle(value: CodeEditor.ISelectionStyle) {
    this._selectionStyle = value;
  }

  /**
   * Get the codemirror editor wrapped by the editor.
   */
  get editor(): CodeMirror.Editor {
    return this._editor;
  }

  /**
   * Get the codemirror doc wrapped by the widget.
   */
  get doc(): CodeMirror.Doc {
    return this._editor.getDoc();
  }

  /**
   * Get the number of lines in the editor.
   */
  get lineCount(): number {
    return this.doc.lineCount();
  }

  /**
   * Control the rendering of line numbers.
   */
  get lineNumbers(): boolean {
    return this._editor.getOption('lineNumbers');
  }
  set lineNumbers(value: boolean) {
    this._editor.setOption('lineNumbers', value);
  }

  /**
   * Set to false for horizontal scrolling. Defaults to true.
   */
  get wordWrap(): boolean {
    return this._editor.getOption('lineWrapping');
  }
  set wordWrap(value: boolean) {
    this._editor.setOption('lineWrapping', value);
  }

  /**
   * Should the editor be read only.
   */
  get readOnly(): boolean {
    return this._editor.getOption('readOnly') !== false;
  }
  set readOnly(readOnly: boolean) {
    this._editor.setOption('readOnly', readOnly);
    if (readOnly) {
      this.host.classList.add(READ_ONLY_CLASS);
    } else {
      this.host.classList.remove(READ_ONLY_CLASS);
      this.blur();
    }
  }

  /**
   * Returns a model for this editor.
   */
  get model(): CodeEditor.IModel {
    return this._model;
  }

  /**
   * The height of a line in the editor in pixels.
   */
  get lineHeight(): number {
    return this._editor.defaultTextHeight();
  }

  /**
   * The widget of a character in the editor in pixels.
   */
  get charWidth(): number {
    return this._editor.defaultCharWidth();
  }

  /**
   * Tests whether the editor is disposed.
   */
  get isDisposed(): boolean {
    return this._editor === null;
  }

  /**
   * Dispose of the resources held by the widget.
   */
  dispose(): void {
    if (this._editor === null) {
      return;
    }
    this.host.removeEventListener('focus', this, true);
    this.host.removeEventListener('scroll', this, true);
    this._editor = null;
    this._model = null;
    this._keydownHandlers.length = 0;
    Signal.clearData(this);
  }

  /**
   * Returns the content for the given line number.
   */
  getLine(line: number): string | undefined {
    return this.doc.getLine(line);
  }

  /**
   * Find an offset for the given position.
   */
  getOffsetAt(position: CodeEditor.IPosition): number {
    return this.doc.indexFromPos({
      ch: position.column,
      line: position.line
    });
  }

  /**
   * Find a position fot the given offset.
   */
  getPositionAt(offset: number): CodeEditor.IPosition {
    const { ch, line } = this.doc.posFromIndex(offset);
    return { line, column: ch };
  }

  /**
   * Undo one edit (if any undo events are stored).
   */
  undo(): void {
    this.doc.undo();
  }

  /**
   * Redo one undone edit.
   */
  redo(): void {
    this.doc.redo();
  }

  /**
   * Clear the undo history.
   */
  clearHistory(): void {
    this.doc.clearHistory();
  }

  /**
   * Brings browser focus to this editor text.
   */
  focus(): void {
    this._editor.focus();
  }

  /**
   * Test whether the editor has keyboard focus.
   */
  hasFocus(): boolean {
    return this._editor.hasFocus();
  }

  /**
   * Explicitly blur the editor.
   */
  blur(): void {
    this._editor.getInputField().blur();
  }

  /**
   * Repaint editor.
   */
  refresh(): void {
    this._editor.refresh();
    this._needsRefresh = false;
  }

  /**
   * Refresh the editor if it is focused;
   * otherwise postpone refreshing till focusing.
   */
  resizeToFit(): void {
    if (this.hasFocus()) {
      this.refresh();
    } else {
      this._needsRefresh = true;
    }
    this._clearHover();
  }

  /**
   * Add a keydown handler to the editor.
   *
   * @param handler - A keydown handler.
   *
   * @returns A disposable that can be used to remove the handler.
   */
  addKeydownHandler(handler: CodeEditor.KeydownHandler): IDisposable {
    this._keydownHandlers.push(handler);
    return new DisposableDelegate(() => {
      ArrayExt.removeAllWhere(this._keydownHandlers, val => val === handler);
    });
  }

  /**
   * Set the size of the editor in pixels.
   */
  setSize(dimension: CodeEditor.IDimension | null): void {
    if (dimension) {
      this._editor.setSize(dimension.width, dimension.height);
    } else {
      this._editor.setSize(null, null);
    }
    this._needsRefresh = false;
  }

  /**
   * Reveal the given position in the editor.
   */
  revealPosition(position: CodeEditor.IPosition): void {
    const cmPosition = this._toCodeMirrorPosition(position);
    this._editor.scrollIntoView(cmPosition);
  }

  /**
   * Reveal the given selection in the editor.
   */
  revealSelection(selection: CodeEditor.IRange): void {
    const range = this._toCodeMirrorRange(selection);
    this._editor.scrollIntoView(range);
  }

  /**
   * Get the window coordinates given a cursor position.
   */
  getCoordinateForPosition(position: CodeEditor.IPosition): CodeEditor.ICoordinate {
    const pos = this._toCodeMirrorPosition(position);
    const rect = this.editor.charCoords(pos, 'page');
    return rect as CodeEditor.ICoordinate;
  }

  /**
   * Get the cursor position given window coordinates.
   *
   * @param coordinate - The desired coordinate.
   *
   * @returns The position of the coordinates, or null if not
   *   contained in the editor.
   */
  getPositionForCoordinate(coordinate: CodeEditor.ICoordinate): CodeEditor.IPosition | null {
    return this._toPosition(this.editor.coordsChar(coordinate)) || null;
  }

  /**
   * Returns the primary position of the cursor, never `null`.
   */
  getCursorPosition(): CodeEditor.IPosition {
    const cursor = this.doc.getCursor();
    return this._toPosition(cursor);
  }

  /**
   * Set the primary position of the cursor.
   *
   * #### Notes
   * This will remove any secondary cursors.
   */
  setCursorPosition(position: CodeEditor.IPosition): void {
    const cursor = this._toCodeMirrorPosition(position);
    this.doc.setCursor(cursor);
    // If the editor does not have focus, this cursor change
    // will get screened out in _onCursorsChanged(). Make an
    // exception for this method.
    if (!this.editor.hasFocus()) {
      this.model.selections.set(this.uuid, this.getSelections());
    }
  }

  /**
   * Returns the primary selection, never `null`.
   */
  getSelection(): CodeEditor.ITextSelection {
    return this.getSelections()[0];
  }

  /**
   * Set the primary selection. This will remove any secondary cursors.
   */
  setSelection(selection: CodeEditor.IRange): void {
    this.setSelections([selection]);
  }

  /**
   * Gets the selections for all the cursors, never `null` or empty.
   */
  getSelections(): CodeEditor.ITextSelection[] {
    const selections = this.doc.listSelections();
    if (selections.length > 0) {
      return selections.map(selection => this._toSelection(selection));
    }
    const cursor = this.doc.getCursor();
    const selection = this._toSelection({ anchor: cursor, head: cursor });
    return [selection];
  }

  /**
   * Sets the selections for all the cursors, should not be empty.
   * Cursors will be removed or added, as necessary.
   * Passing an empty array resets a cursor position to the start of a document.
   */
  setSelections(selections: CodeEditor.IRange[]): void {
    const cmSelections = this._toCodeMirrorSelections(selections);
    this.doc.setSelections(cmSelections, 0);
  }

  /**
   * Handle keydown events from the editor.
   */
  protected onKeydown(event: KeyboardEvent): boolean {
    let position = this.getCursorPosition();
    let { line, column } = position;

    if (line === 0 && column === 0 && event.keyCode === UP_ARROW) {
      if (!event.shiftKey) {
        this.edgeRequested.emit('top');
      }
      return false;
    }

    let lastLine = this.lineCount - 1;
    let lastCh = this.getLine(lastLine).length;
    if (line === lastLine && column === lastCh
        && event.keyCode === DOWN_ARROW) {
      if (!event.shiftKey) {
        this.edgeRequested.emit('bottom');
      }
      return false;
    }
    return false;
  }

  /**
   * Converts selections to code mirror selections.
   */
  private _toCodeMirrorSelections(selections: CodeEditor.IRange[]): CodeMirror.Selection[] {
    if (selections.length > 0) {
      return selections.map(selection => this._toCodeMirrorSelection(selection));
    }
    const position = { line: 0, ch: 0 };
    return [{ anchor: position, head: position }];
  }

  /**
   * Handles a mime type change.
   */
  private _onMimeTypeChanged(): void {
    const mime = this._model.mimeType;
    let editor = this._editor;
    Mode.ensure(mime).then(spec => {
      editor.setOption('mode', spec.mime);
    });
    let isCode = (mime !== 'text/plain') && (mime !== 'text/x-ipythongfm');
    editor.setOption('matchBrackets', isCode);
    editor.setOption('autoCloseBrackets', isCode);
    let extraKeys = editor.getOption('extraKeys') || {};
    if (isCode) {
      extraKeys['Backspace'] = 'delSpaceToPrevTabStop';
    } else {
      delete extraKeys['Backspace'];
    }
    editor.setOption('extraKeys', extraKeys);
  }

  /**
   * Handles a selections change.
   */
  private _onSelectionsChanged(selections: IObservableMap<CodeEditor.ITextSelection[]>, args: IObservableMap.IChangedArgs<CodeEditor.ITextSelection[]>): void {
    const uuid = args.key;
    if (uuid !== this.uuid) {
      this._cleanSelections(uuid);
      if (args.type !== 'remove') {
        this._markSelections(uuid, args.newValue);
      }
    }
  }

  /**
   * Clean selections for the given uuid.
   */
  private _cleanSelections(uuid: string) {
    const markers = this.selectionMarkers[uuid];
    if (markers) {
      markers.forEach(marker => { marker.clear(); });
    }
    delete this.selectionMarkers[uuid];
  }

  /**
   * Marks selections.
   */
  private _markSelections(uuid: string, selections: CodeEditor.ITextSelection[]) {
    const markers: CodeMirror.TextMarker[] = [];

    // If we are marking selections corresponding to an active hover,
    // remove it.
    if (uuid === this._hoverId) {
      this._clearHover();
    }
    // If we can id the selection to a specific collaborator,
    // use that information.
    let collaborator: ICollaborator;
    if (this._model.modelDB.collaborators) {
      collaborator = this._model.modelDB.collaborators.get(uuid);
    }

    // Style each selection for the uuid.
    selections.forEach(selection => {
      // Only render selections if the start is not equal to the end.
      // In that case, we don't need to render the cursor.
      if (!JSONExt.deepEqual(selection.start, selection.end)) {
        const { anchor, head } = this._toCodeMirrorSelection(selection);
        let markerOptions: CodeMirror.TextMarkerOptions;
        if (collaborator) {
          markerOptions = this._toTextMarkerOptions({
            ...selection.style,
            color: collaborator.color
          });
        } else {
          markerOptions = this._toTextMarkerOptions(selection.style);
        }
        markers.push(this.doc.markText(anchor, head, markerOptions));
      } else {
        let caret = this._getCaret(collaborator);
        markers.push(this.doc.setBookmark(
          this._toCodeMirrorPosition(selection.end), {widget: caret}));
      }
    });
    this.selectionMarkers[uuid] = markers;
  }

  /**
   * Handles a cursor activity event.
   */
  private _onCursorActivity(): void {
    // Only add selections if the editor has focus. This avoids unwanted
    // triggering of cursor activity due to collaborator actions.
    if (this._editor.hasFocus()) {
      const selections = this.getSelections();
      this.model.selections.set(this.uuid, selections);
    }
  }

  /**
   * Converts a code mirror selection to an editor selection.
   */
  private _toSelection(selection: CodeMirror.Selection): CodeEditor.ITextSelection {
    return {
      uuid: this.uuid,
      start: this._toPosition(selection.anchor),
      end: this._toPosition(selection.head),
      style: this.selectionStyle
    };
  }

  /**
   * Converts the selection style to a text marker options.
   */
  private _toTextMarkerOptions(style: CodeEditor.ISelectionStyle | undefined): CodeMirror.TextMarkerOptions | undefined {
    if (style) {
      let css: string;
      if (style.color) {
        let r = parseInt(style.color.slice(1,3), 16);
        let g  = parseInt(style.color.slice(3,5), 16);
        let b  = parseInt(style.color.slice(5,7), 16);
        css = `background-color: rgba( ${r}, ${g}, ${b}, 0.15)`;
      }
      return {
        className: style.className,
        title: style.displayName,
        css
      };
    }
    return undefined;
  }

  /**
   * Converts an editor selection to a code mirror selection.
   */
  private _toCodeMirrorSelection(selection: CodeEditor.IRange): CodeMirror.Selection {
    // Selections only appear to render correctly if the anchor
    // is before the head in the document. That is, reverse selections
    // do not appear as intended.
    let forward: boolean = (selection.start.line < selection.end.line) ||
                           (selection.start.line === selection.end.line &&
                            selection.start.column <= selection.end.column);
    let anchor = forward ? selection.start : selection.end;
    let head = forward ? selection.end : selection.start;
    return {
      anchor: this._toCodeMirrorPosition(anchor),
      head: this._toCodeMirrorPosition(head)
    };
  }

  /**
   * Converts an editor selection to a code mirror selection.
   */
  private _toCodeMirrorRange(range: CodeEditor.IRange): CodeMirror.Range {
    return {
      from: this._toCodeMirrorPosition(range.start),
      to: this._toCodeMirrorPosition(range.end)
    };
  }

  /**
   * Convert a code mirror position to an editor position.
   */
  private _toPosition(position: CodeMirror.Position) {
    return {
      line: position.line,
      column: position.ch
    };
  }

  /**
   * Convert an editor position to a code mirror position.
   */
  private _toCodeMirrorPosition(position: CodeEditor.IPosition) {
    return {
      line: position.line,
      ch: position.column
    };
  }

  /**
   * Handle model value changes.
   */
  private _onValueChanged(value: IObservableString, args: IObservableString.IChangedArgs): void {
    if (this._changeGuard) {
      return;
    }
    this._changeGuard = true;
    let doc = this.doc;
    switch (args.type) {
     case 'insert':
       let pos = doc.posFromIndex(args.start);
       doc.replaceRange(args.value, pos, pos);
       break;
     case 'remove':
       let from = doc.posFromIndex(args.start);
       let to = doc.posFromIndex(args.end);
       doc.replaceRange('', from, to);
       break;
     case 'set':
       doc.setValue(args.value);
       break;
     default:
       break;
    }
    this._changeGuard = false;
  }

  /**
   * Handles document changes.
   */
  private _beforeDocChanged(doc: CodeMirror.Doc, change: CodeMirror.EditorChange) {
    if (this._changeGuard) {
      return;
    }
    this._changeGuard = true;
    let value = this._model.value;
    let start = doc.indexFromPos(change.from);
    let end = doc.indexFromPos(change.to);
    let inserted = change.text.join('\n');

    if (end !== start) {
      value.remove(start, end);
    }
    if (inserted) {
      value.insert(start, inserted);
    }
    this._changeGuard = false;
  }

  /**
   * Handle the DOM events for the editor.
   *
   * @param event - The DOM event sent to the editor.
   *
   * #### Notes
   * This method implements the DOM `EventListener` interface and is
   * called in response to events on the editor's DOM node. It should
   * not be called directly by user code.
   */
  handleEvent(event: Event): void {
    switch (event.type) {
    case 'focus':
      this._evtFocus(event as FocusEvent);
      break;
    case 'scroll':
      this._evtScroll();
      break;
    default:
      break;
    }
  }

  /**
   * Handle `focus` events for the editor.
   */
  private _evtFocus(event: FocusEvent): void {
    if (this._needsRefresh) {
      this.refresh();
    }
  }

  /**
   * Handle `scroll` events for the editor.
   */
  private _evtScroll(): void {
    // Remove any active hover.
    this._clearHover();
  }

  /**
   * Clear the hover for a caret, due to things like
   * scrolling, resizing, deactivation, etc, where
   * the position is no longer valid.
   */
  private _clearHover(): void {
    if (this._caretHover) {
      window.clearTimeout(this._hoverTimeout);
      document.body.removeChild(this._caretHover);
      this._caretHover = null;
    }
  }

  /**
   * Construct a caret element representing the position
   * of a collaborator's cursor.
   */
  private _getCaret(collaborator: ICollaborator): HTMLElement {
    let name = collaborator ? collaborator.displayName : 'Anonymous';
    let color = collaborator ? collaborator.color : this._selectionStyle.color;
    let caret: HTMLElement = document.createElement('span');
    caret.className = COLLABORATOR_CURSOR_CLASS;
    caret.style.borderBottomColor = color;
    caret.onmouseenter = () => {
      this._clearHover();
      this._hoverId = collaborator.sessionId;
      let rect = caret.getBoundingClientRect();
      // Construct and place the hover box.
      let hover = document.createElement('div');
      hover.className = COLLABORATOR_HOVER_CLASS;
      hover.style.left = String(rect.left)+'px';
      hover.style.top = String(rect.bottom)+'px';
      hover.textContent = name;
      hover.style.backgroundColor = color;

      // If the user mouses over the hover, take over the timer.
      hover.onmouseenter = () => {
        window.clearTimeout(this._hoverTimeout);
      }
      hover.onmouseleave = () => {
        this._hoverTimeout = window.setTimeout(() => {
          this._clearHover();
        }, HOVER_TIMEOUT);
      }
      this._caretHover = hover;
      document.body.appendChild(hover);
    };
    caret.onmouseleave = () => {
      this._hoverTimeout = window.setTimeout(() => {
        this._clearHover();
      }, HOVER_TIMEOUT);
    };
    return caret;
  }

  private _model: CodeEditor.IModel;
  private _editor: CodeMirror.Editor;
  protected selectionMarkers: { [key: string]: CodeMirror.TextMarker[] | undefined } = {};
  private _caretHover: HTMLElement = null;
  private _hoverTimeout: number = null;
  private _hoverId: string = null;
  private _keydownHandlers = new Array<CodeEditor.KeydownHandler>();
  private _changeGuard = false;
  private _selectionStyle: CodeEditor.ISelectionStyle;
  private _uuid = '';
  private _needsRefresh = false;
}


/**
 * The namespace for `CodeMirrorEditor` statics.
 */
export
namespace CodeMirrorEditor {
  /**
   * The options used to initialize a code mirror editor.
   */
  export
  interface IOptions extends CodeEditor.IOptions {
    /**
     * The mode to use. When not given, this will default to the first mode
     * that was loaded.
     */
    mode?: string | Mode.ISpec;

    /**
     * The theme to style the editor with.
     * You must make sure the CSS file defining the corresponding
     * .cm-s-[name] styles is loaded.
     * The default is "jupyter".
     */
    theme?: string;

    /**
     * How many spaces a block (whatever that means in the edited language)
     * should be indented. The default is 2.
     */
    indentUnit?: number;

    /**
     * Whether to use the context-sensitive indentation that the mode provides
     * (or just indent the same as the line before). Defaults to true.
     */
    smartIndent?: boolean;

    /**
     * The width of a tab character. Defaults to 4.
     */
    tabSize?: number;

    /**
     * Whether, when indenting, the first N*tabSize spaces should be replaced
     * by N tabs. Default is false.
     */
    indentWithTabs?: boolean;

    /**
     * Configures whether the editor should re-indent the current line when a
     * character is typed that might change its proper indentation
     * (only works if the mode supports indentation). Default is true.
     */
    electricChars?: boolean;

    /**
     * Determines whether horizontal cursor movement through right-to-left
     * (Arabic, Hebrew) text is visual (pressing the left arrow moves the
     * cursor left)
     * or logical (pressing the left arrow moves to the next lower index in
     * the string, which is visually right in right-to-left text).
     * The default is false on Windows, and true on other platforms.
     */
    rtlMoveVisually?: boolean;

    /**
     * Configures the keymap to use. The default is "default", which is the
     * only keymap defined in codemirror.js itself.
     * Extra keymaps are found in the CodeMirror keymap directory.
     */
    keyMap?: string;

    /**
     * Can be used to specify extra keybindings for the editor, alongside the
     * ones defined by keyMap. Should be either null, or a valid keymap value.
     */
    extraKeys?: any;

    /**
     * At which number to start counting lines. Default is 1.
     */
    firstLineNumber?: number;

    /**
     * Can be used to add extra gutters (beyond or instead of the line number
     * gutter).
     * Should be an array of CSS class names, each of which defines a width
     * (and optionally a background),
     * and which will be used to draw the background of the gutters.
     * May include the CodeMirror-linenumbers class, in order to explicitly
     * set the position of the line number gutter
     * (it will default to be to the right of all other gutters).
     * These class names are the keys passed to setGutterMarker.
     */
    gutters?: string[];

    /**
     * Determines whether the gutter scrolls along with the content
     * horizontally (false)
     * or whether it stays fixed during horizontal scrolling (true,
     * the default).
     */
    fixedGutter?: boolean;

    /**
     * Whether the cursor should be drawn when a selection is active.
     * Defaults to false.
     */
    showCursorWhenSelecting?: boolean;

    /**
     * The maximum number of undo levels that the editor stores.
     * Defaults to 40.
     */
    undoDepth?: number;

    /**
     * The period of inactivity (in milliseconds) that will cause a new
     * history event to be started when typing or deleting. Defaults to 500.
     */
    historyEventDelay?: number;

    /**
     * The tab index to assign to the editor. If not given, no tab index will
     * be assigned.
     */
    tabindex?: number;

    /**
     * Can be used to make CodeMirror focus itself on initialization.
     * Defaults to off.
     */
    autofocus?: boolean;

    /**
     * Controls whether drag-and - drop is enabled. On by default.
     */
    dragDrop?: boolean;

    /**
     * Half - period in milliseconds used for cursor blinking.
     * The default blink rate is 530ms.
     */
    cursorBlinkRate?: number;

    /**
     * Determines the height of the cursor. Default is 1, meaning it spans
     * the whole height of the line.
     * For some fonts (and by some tastes) a smaller height (for example 0.85),
     * which causes the cursor to not reach all the way to the bottom of the
     * line, looks better
     */
    cursorHeight?: number;

    /**
     * Highlighting is done by a pseudo background - thread that will work for
     * workTime milliseconds,
     * and then use timeout to sleep for workDelay milliseconds.
     * The defaults are 200 and 300, you can change these options to make the
     * highlighting more or less aggressive.
     */
    workTime?: number;

    /**
     * See workTime.
     */
    workDelay?: number;

    /**
     * Indicates how quickly CodeMirror should poll its input textarea for
     * changes(when focused).
     * Most input is captured by events, but some things, like IME input on
     * some browsers, don't generate events that allow CodeMirror to properly
     * detect it.
     * Thus, it polls. Default is 100 milliseconds.
     */
    pollInterval?: number;

    /**
     * By default, CodeMirror will combine adjacent tokens into a single span
     * if they have the same class.
     * This will result in a simpler DOM tree, and thus perform better. With
     * some kinds of styling(such as rounded corners),
     * this will change the way the document looks. You can set this option to
     * false to disable this behavior.
     */
    flattenSpans?: boolean;

    /**
     * When highlighting long lines, in order to stay responsive, the editor
     * will give up and simply style
     * the rest of the line as plain text when it reaches a certain position.
     * The default is 10000.
     * You can set this to Infinity to turn off this behavior.
     */
    maxHighlightLength?: number;

    /**
     * Specifies the amount of lines that are rendered above and below the
     * part of the document that's currently scrolled into view.
     * This affects the amount of updates needed when scrolling, and the
     * amount of work that such an update does.
     * You should usually leave it at its default, 10. Can be set to Infinity
     * to make sure the whole document is always rendered,
     * and thus the browser's text search works on it. This will have bad
     * effects on performance of big documents.
     */
    viewportMargin?: number;
  }

  /**
   * The name of the default CodeMirror theme
   */
  export
  const DEFAULT_THEME: string = 'jupyter';

  /**
   * Add a command to CodeMirror.
   *
   * @param name - The name of the command to add.
   *
   * @param command - The command function.
   */
  export
  function addCommand(name: string, command: (cm: CodeMirror.Editor) => void) {
    CodeMirror.commands[name] = command;
  }
}


/**
 * The namespace for module private data.
 */
namespace Private {
  /**
   * Handle extra codemirror config from codeeditor options.
   */
  export
  function handleOptions(options: CodeMirrorEditor.IOptions): CodeMirror.EditorConfiguration {
    let config = {
      ...options,
      readOnly: options.readOnly !== undefined ? options.readOnly : false,
      lineNumbers: options.lineNumbers !== undefined ? options.lineNumbers : false,
      lineWrapping: options.wordWrap !== undefined ? options.wordWrap : true,
      theme: options.theme || CodeMirrorEditor.DEFAULT_THEME
    } as CodeMirror.EditorConfiguration;

    // Remove extra keys.
    for (let key of ['host', 'model', 'uuid', 'wordWrap', 'selectionStyle']) {
      if (config.hasOwnProperty(key)) {
        delete (config as any)[key];
      }
    }

    return config;
  }

  /**
   * Delete spaces to the previous tab stob in a codemirror editor.
   */
  export
  function delSpaceToPrevTabStop(cm: CodeMirror.Editor): void {
    let doc = cm.getDoc();
    let from = doc.getCursor('from');
    let to = doc.getCursor('to');
    let sel = !posEq(from, to);
    if (sel) {
      let ranges = doc.listSelections();
      for (let i = ranges.length - 1; i >= 0; i--) {
        let head = ranges[i].head;
        let anchor = ranges[i].anchor;
        doc.replaceRange('', CodeMirror.Pos(head.line, head.ch), CodeMirror.Pos(anchor.line, anchor.ch));
      }
      return;
    }
    let cur = doc.getCursor();
    let tabsize = cm.getOption('tabSize');
    let chToPrevTabStop = cur.ch - (Math.ceil(cur.ch / tabsize) - 1) * tabsize;
    from = {ch: cur.ch - chToPrevTabStop, line: cur.line};
    let select = doc.getRange(from, cur);
    if (select.match(/^\ +$/) !== null) {
      doc.replaceRange('', from, cur);
    } else {
      CodeMirror.commands['delCharBefore'](cm);
    }
  };

  /**
   * Test whether two CodeMirror positions are equal.
   */
  export
  function posEq(a: CodeMirror.Position, b: CodeMirror.Position): boolean {
    return a.line === b.line && a.ch === b.ch;
  };
}


/**
 * Add a CodeMirror command to delete until previous non blanking space
 * character or first multiple of tabsize tabstop.
 */
CodeMirrorEditor.addCommand(
  'delSpaceToPrevTabStop', Private.delSpaceToPrevTabStop
);

