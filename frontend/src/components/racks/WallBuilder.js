import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { wallLayout, BOX_KINDS } from '../../utils/wallLayout';
import {
  addBox, removeBox, setKind, setHolds, setSpan, maxSpan, setGrid, minGrid, boxAt, findBox,
  boxCapacity, WALL_MAX_COLS, WALL_MAX_ROWS, MAX_PER_SECTION, MAX_BOX_DIM,
} from '../../utils/wallEdit';
import { SLOT_RADIUS } from '../../utils/rackLayouts';
import WallDecor from './WallDecor';
import IntegerField from '../IntegerField';
import './WallBuilder.css';

// What each content asks for: [field, translation key, English].
const HOLDS = {
  x: [['perSection', 'racks.wall.perTriangle', 'Bottles per triangle']],
  slash: [['perSection', 'racks.wall.perHalf', 'Bottles per half']],
  backslash: [['perSection', 'racks.wall.perHalf', 'Bottles per half']],
  bin: [['perSection', 'racks.wall.binBottles', 'Bottles']],
  rack: [['rows', 'racks.wall.rackRows', 'Rows'], ['cols', 'racks.wall.rackCols', 'Bottles per row']],
  shelves: [['rows', 'racks.wall.shelfCount', 'Shelves'], ['cols', 'racks.wall.perShelf', 'Bottles per shelf']],
  closed: [],
};
const KIND_NAMES = {
  x: 'X', slash: 'Diagonal /', backslash: 'Diagonal \\', bin: 'Open bin', rack: 'Rack', shelves: 'Shelves', closed: 'Closed',
};

function KindIcon({ kind }) {
  return (
    <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="3" y="3" width="16" height="16" rx="1.5" />
      {(kind === 'x' || kind === 'backslash') && <path d="M3 3l16 16" />}
      {(kind === 'x' || kind === 'slash') && <path d="M19 3L3 19" />}
      {kind === 'rack' && [[8, 8], [14, 8], [8, 14], [14, 14]].map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.6" />)}
      {kind === 'shelves' && <path d="M3 9h16M3 14.5h16" />}
      {kind === 'bin' && [[7.5, 15.5], [11.5, 15.5], [15.5, 15.5], [9.5, 12]].map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.7" />)}
      {kind === 'closed' && <><rect x="6" y="6" width="10" height="10" /><circle cx="14" cy="11" r="0.9" /></>}
    </svg>
  );
}

const onKey = (run) => (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  run();
};

/**
 * Build or change a wall rack: a grid of cells with boxes on it, each box
 * holding one content. The form owns the wall ({ rows, cols, boxes }) and
 * gets every change through `onChange`; the moves themselves are in
 * utils/wallEdit.js, and each keeps the wall one the server accepts.
 *
 * `usage` (utils/wallEdit.usageByBox) is given when the wall is a stored rack
 * with bottles in it: a box that holds bottles cannot be removed or given
 * another content here, and cannot shrink under a bottle, which is what the
 * server refuses as well.
 */
export default function WallBuilder({ wall, onChange, usage, disabled = false }) {
  const { t } = useTranslation();
  const [sel, setSel] = useState(null);
  const layout = useMemo(() => wallLayout(wall.rows, wall.cols, { boxes: wall.boxes }), [wall]);
  const min = minGrid(wall);

  const box = sel?.type === 'box' ? findBox(wall, sel.key) : null;
  const cell = sel?.type === 'cell' && sel.x < wall.cols && sel.y < wall.rows && !boxAt(wall, sel.x, sel.y) ? sel : null;
  const drawn = box ? layout.wall.boxes.find((b) => b.key === sel.key) : null;
  const used = box ? usage?.get(sel.key) : null;
  const span = box ? maxSpan(wall, sel.key) : null;
  const kindName = (kind) => t(`racks.wall.kind_${kind}`, KIND_NAMES[kind]);
  const cellName = (x, y) => `${layout.wall.axes.find((a) => a.key === `col-${x}`)?.label || 'A'}${y + 1}`;

  const pickKind = (kind) => {
    if (box) { onChange(setKind(wall, sel.key, kind)); return; }
    if (!cell) return;
    const added = addBox(wall, cell.x, cell.y, kind);
    onChange(added.wall);
    if (added.key) setSel({ type: 'box', key: added.key });
  };

  const kindButtons = (current, locked) => (
    <div className="wall-builder-kinds">
      {BOX_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          className={`wall-builder-kind ${kind === current ? 'selected' : ''}`}
          aria-pressed={kind === current}
          disabled={disabled || (locked && kind !== current)}
          onClick={() => pickKind(kind)}
        >
          <KindIcon kind={kind} />
          <span>{kindName(kind)}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="wall-builder">
      <div className="wall-builder-grid">
        <label className="form-group">
          <span>{t('racks.wall.cellsWide', 'Wall width (cells)')}</span>
          <IntegerField
            min={min.cols} max={WALL_MAX_COLS} value={wall.cols} disabled={disabled}
            onCommit={(cols) => onChange(setGrid(wall, wall.rows, cols))}
          />
        </label>
        <label className="form-group">
          <span>{t('racks.wall.cellsHigh', 'Wall height (cells)')}</span>
          <IntegerField
            min={min.rows} max={WALL_MAX_ROWS} value={wall.rows} disabled={disabled}
            onCommit={(rows) => onChange(setGrid(wall, rows, wall.cols))}
          />
        </label>
        <p className="help-text wall-builder-hint">
          {t('racks.wall.hint', 'Tap a box to change what is inside it. Tap a dashed cell to add a box there.')}
        </p>
      </div>

      <div className="wall-builder-canvas">
        <svg
          viewBox={`0 0 ${layout.viewBox.width} ${layout.viewBox.height}`}
          className="wall-builder-svg"
          role="group"
          aria-label={t('racks.wall.canvasLabel', { cols: wall.cols, rows: wall.rows, defaultValue: 'The wall, {{cols}} cells wide and {{rows}} high' })}
        >
          <WallDecor wall={layout.wall} />
          {layout.slots.map((s) => (
            <circle key={s.position} className="wall-builder-slot" cx={s.cx} cy={s.cy} r={SLOT_RADIUS} />
          ))}
          {layout.wall.emptyCells.map((c) => {
            const on = cell && cell.x === c.col && cell.y === c.row;
            const pick = () => setSel({ type: 'cell', x: c.col, y: c.row });
            const m = c.size / 2;
            return (
              <g
                key={`cell-${c.col}-${c.row}`}
                className={`wall-builder-cell ${on ? 'selected' : ''}`}
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-pressed={!!on}
                aria-label={t('racks.wall.cellAria', { label: cellName(c.col, c.row), defaultValue: 'Empty wall at {{label}}, add a box' })}
                onClick={disabled ? undefined : pick}
                onKeyDown={disabled ? undefined : onKey(pick)}
              >
                <rect x={c.x + 10} y={c.y + 10} width={c.size - 20} height={c.size - 20} rx={6} />
                <line x1={c.x + m - 16} y1={c.y + m} x2={c.x + m + 16} y2={c.y + m} />
                <line x1={c.x + m} y1={c.y + m - 16} x2={c.x + m} y2={c.y + m + 16} />
              </g>
            );
          })}
          {layout.wall.boxes.map((b) => {
            const on = box && sel.key === b.key;
            const pick = () => setSel({ type: 'box', key: b.key });
            const bottles = usage?.get(b.key)?.bottles;
            return (
              <g key={b.key}>
                {bottles ? (
                  <g className="wall-builder-count" aria-hidden="true">
                    <rect x={b.x + b.width - 66} y={b.y + 14} width={52} height={30} rx={15} />
                    <text x={b.x + b.width - 40} y={b.y + 29} textAnchor="middle" dominantBaseline="central">{bottles}</text>
                  </g>
                ) : null}
                <rect
                  className={`wall-builder-hit ${on ? 'selected' : ''}`}
                  x={b.x} y={b.y} width={b.width} height={b.height}
                  role="button"
                  tabIndex={disabled ? -1 : 0}
                  aria-pressed={!!on}
                  aria-label={t('racks.wall.boxAria', { label: b.label, kind: kindName(b.kind), n: b.capacity, defaultValue: 'Box {{label}}, {{kind}}, {{n}} bottles' })}
                  onClick={disabled ? undefined : pick}
                  onKeyDown={disabled ? undefined : onKey(pick)}
                />
              </g>
            );
          })}
        </svg>
      </div>

      <div className="wall-builder-panel" aria-live="polite">
        {box && drawn && (
          <>
            <div className="wall-builder-panel-head">
              <strong>{t('racks.wall.boxTitle', { label: drawn.label, defaultValue: 'Box {{label}}' })}</strong>
              <span className="wall-builder-sub">
                {boxCapacity(box) > 0
                  ? t('racks.wall.boxHolds', { n: boxCapacity(box), defaultValue: 'Holds {{n}} bottles' })
                  : t('racks.wall.boxHoldsNone', 'Holds no bottles')}
              </span>
            </div>
            {used && (
              <p className="help-text wall-builder-used">
                {t('racks.wall.inUse', { n: used.bottles, defaultValue: '{{n}} bottles lie in this box. Move them out before you remove it or change what is inside. It can still grow.' })}
              </p>
            )}
            <div className="wall-builder-section">
              <span className="wall-builder-label">{t('racks.wall.inside', 'Inside')}</span>
              {kindButtons(box.kind, !!used)}
            </div>
            {HOLDS[box.kind].length > 0 && (
              <div className="wall-builder-section wall-builder-fields">
                {HOLDS[box.kind].map(([field, key, english]) => (
                  <label key={field} className="form-group">
                    <span>{t(key, english)}</span>
                    <IntegerField
                      min={used ? used[field] : 1}
                      max={field === 'perSection' ? MAX_PER_SECTION : MAX_BOX_DIM}
                      value={box[field]}
                      disabled={disabled}
                      onCommit={(value) => onChange(setHolds(wall, sel.key, field, value))}
                    />
                  </label>
                ))}
              </div>
            )}
            <div className="wall-builder-section wall-builder-fields">
              <label className="form-group">
                <span>{t('racks.wall.boxWide', 'Box width (cells)')}</span>
                <IntegerField
                  min={1} max={span.w} value={box.w} disabled={disabled || span.w === 1}
                  onCommit={(w) => onChange(setSpan(wall, sel.key, w, box.h))}
                />
              </label>
              <label className="form-group">
                <span>{t('racks.wall.boxHigh', 'Box height (cells)')}</span>
                <IntegerField
                  min={1} max={span.h} value={box.h} disabled={disabled || span.h === 1}
                  onCommit={(h) => onChange(setSpan(wall, sel.key, box.w, h))}
                />
              </label>
              <p className="help-text wall-builder-hint">
                {t('racks.wall.spanHint', 'A box can grow into the empty wall beside it or below it.')}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary wall-builder-remove"
              disabled={disabled || !!used}
              onClick={() => {
                onChange(removeBox(wall, sel.key));
                setSel({ type: 'cell', x: box.x, y: box.y });
              }}
            >
              {t('racks.wall.remove', 'Remove this box')}
            </button>
          </>
        )}
        {!box && cell && (
          <>
            <div className="wall-builder-panel-head">
              <strong>{t('racks.wall.emptyTitle', { label: cellName(cell.x, cell.y), defaultValue: 'Empty wall at {{label}}' })}</strong>
              <span className="wall-builder-sub">{t('racks.wall.emptyHint', 'Choose what to put here.')}</span>
            </div>
            {kindButtons(null, false)}
          </>
        )}
        {!box && !cell && (
          <p className="help-text">{t('racks.wall.nothingSelected', 'No box is chosen. Tap one in the wall above.')}</p>
        )}
      </div>
    </div>
  );
}
