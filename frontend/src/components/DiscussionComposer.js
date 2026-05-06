import { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import { useTranslation } from 'react-i18next';
import './DiscussionComposer.css';

// Shared rich-text composer for the create-discussion modal and the reply
// form. Output is HTML matching the backend allowlist:
//   p, br, strong, em, s, u, blockquote, ul, ol, li, a
//
// We keep StarterKit but drop heading/code/codeBlock/horizontalRule — those
// would either fall outside the backend allowlist (heading -> stripped) or
// don't fit the wine-talk register.
//
// Visible-text length is reported via onTextLengthChange so the parent can
// show a counter and disable the submit button. Counting visible text (not
// raw HTML) matches the backend validation, which is the user's mental model.
export default function DiscussionComposer({
  value,
  onChange,
  onTextLengthChange,
  placeholder,
  maxVisibleLength,
  minHeight = 120,
  testId
}) {
  const { t } = useTranslation();

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        code: false,
        horizontalRule: false
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          target: '_blank',
          rel: 'noopener noreferrer nofollow'
        }
      }),
      Placeholder.configure({
        placeholder: placeholder || t('discussions.bodyPlaceholder')
      })
    ],
    content: value || '',
    onUpdate: ({ editor: ed }) => {
      const html = ed.isEmpty ? '' : ed.getHTML();
      onChange?.(html);
      onTextLengthChange?.(ed.getText().length);
    }
  });

  // External resets (e.g. clearing the form after submit) need to be reflected
  // back into the editor. We only update when the value diverges to avoid
  // breaking caret position during normal typing.
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? '' : editor.getHTML();
    if ((value || '') !== current) {
      editor.commands.setContent(value || '', false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  if (!editor) return null;

  const setLink = () => {
    const previous = editor.getAttributes('link').href;
    const url = window.prompt(t('discussions.linkUrl'), previous || '');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    // Only allow http/https/mailto — same set the backend allowlist accepts
    if (!/^(https?:|mailto:)/i.test(url)) return;
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  return (
    <div className="discussion-composer" data-testid={testId}>
      <div className="discussion-composer__toolbar" role="toolbar" aria-label={t('discussions.composerToolbar')}>
        <button
          type="button"
          className={`discussion-composer__btn ${editor.isActive('bold') ? 'is-active' : ''}`}
          onClick={() => editor.chain().focus().toggleBold().run()}
          aria-label={t('discussions.bold')}
          title={t('discussions.bold')}
        ><strong>B</strong></button>
        <button
          type="button"
          className={`discussion-composer__btn ${editor.isActive('italic') ? 'is-active' : ''}`}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          aria-label={t('discussions.italic')}
          title={t('discussions.italic')}
        ><em>I</em></button>
        <button
          type="button"
          className={`discussion-composer__btn ${editor.isActive('underline') ? 'is-active' : ''}`}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          aria-label={t('discussions.underline')}
          title={t('discussions.underline')}
        ><u>U</u></button>
        <button
          type="button"
          className={`discussion-composer__btn ${editor.isActive('strike') ? 'is-active' : ''}`}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          aria-label={t('discussions.strike')}
          title={t('discussions.strike')}
        ><s>S</s></button>
        <span className="discussion-composer__sep" />
        <button
          type="button"
          className={`discussion-composer__btn ${editor.isActive('bulletList') ? 'is-active' : ''}`}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          aria-label={t('discussions.bulletList')}
          title={t('discussions.bulletList')}
        >•</button>
        <button
          type="button"
          className={`discussion-composer__btn ${editor.isActive('orderedList') ? 'is-active' : ''}`}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          aria-label={t('discussions.orderedList')}
          title={t('discussions.orderedList')}
        >1.</button>
        <button
          type="button"
          className={`discussion-composer__btn ${editor.isActive('blockquote') ? 'is-active' : ''}`}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          aria-label={t('discussions.quote')}
          title={t('discussions.quote')}
        >“”</button>
        <button
          type="button"
          className={`discussion-composer__btn ${editor.isActive('link') ? 'is-active' : ''}`}
          onClick={setLink}
          aria-label={t('discussions.link')}
          title={t('discussions.link')}
        >🔗</button>
      </div>
      <EditorContent
        editor={editor}
        className="discussion-composer__content"
        style={{ minHeight: `${minHeight}px` }}
      />
      {typeof maxVisibleLength === 'number' && (
        <div className="discussion-composer__counter">
          {editor.getText().length} / {maxVisibleLength}
        </div>
      )}
    </div>
  );
}
