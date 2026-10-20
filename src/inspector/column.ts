// The column a form cell shows (owner: describe-status). Kept apart from status.ts so the editor card
// (ui/editor.ts), which status.ts imports, can use it without an import cycle. The logic lives in core/column.ts,
// where the save rules (core/model.ts standIn) use it too.

export { columnOf } from '../core/column';
