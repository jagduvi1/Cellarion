import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Youtube from '@tiptap/extension-youtube';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import { getAdminBlogPost, createBlogPost, updateBlogPost } from '../api/blog';
import './AdminBlogEditor.css';

function AdminBlogEditor() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const { apiFetch } = useAuth();
  const isNew = !id || id === 'new';

  const [title, setTitle] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [coverImage, setCoverImage] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [status, setStatus] = useState('draft');
  const [metaTitle, setMetaTitle] = useState('');
  const [metaDescription, setMetaDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!isNew);
  const [showSource, setShowSource] = useState(false);
  const [sourceHtml, setSourceHtml] = useState('');

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] }
      }),
      Link.configure({ openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
      Image.configure({ inline: false, allowBase64: false }),
      Youtube.configure({ width: 640, height: 360 }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: t('blog.editor.contentPlaceholder') })
    ],
    content: '',
  });

  const loadPost = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    try {
      const res = await getAdminBlogPost(apiFetch, id);
      const data = await res.json();
      const post = data.post;
      setTitle(post.title);
      setExcerpt(post.excerpt || '');
      setCoverImage(post.coverImage || '');
      setTagsInput((post.tags || []).join(', '));
      setStatus(post.status);
      setMetaTitle(post.metaTitle || '');
      setMetaDescription(post.metaDescription || '');
      if (editor) editor.commands.setContent(post.content || '');
    } catch {
      alert(t('blog.editor.loadFailed'));
      navigate('/admin/blog');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, id, isNew, editor, navigate, t]);

  useEffect(() => { loadPost(); }, [loadPost]);

  const handleSave = async (publishOverride) => {
    if (!title.trim()) {
      alert(t('blog.editor.titleRequired'));
      return;
    }
    const content = showSource ? sourceHtml : editor.getHTML();
    if (!content || content === '<p></p>') {
      alert(t('blog.editor.contentRequired'));
      return;
    }

    setSaving(true);
    const data = {
      title: title.trim(),
      content,
      excerpt: excerpt.trim(),
      coverImage: coverImage.trim(),
      tags: tagsInput.split(',').map(t => t.trim()).filter(Boolean),
      status: publishOverride || status,
      metaTitle: metaTitle.trim(),
      metaDescription: metaDescription.trim()
    };

    try {
      if (isNew) {
        const res = await createBlogPost(apiFetch, data);
        const result = await res.json();
        navigate(`/admin/blog/${result.post._id}`);
      } else {
        await updateBlogPost(apiFetch, id, data);
      }
      if (publishOverride === 'published') {
        alert(t('blog.editor.published'));
      }
    } catch {
      alert(t('blog.editor.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const toggleSource = () => {
    if (!editor) return;
    if (showSource) {
      // Switching from source back to WYSIWYG — apply the edited HTML
      editor.commands.setContent(sourceHtml);
      setShowSource(false);
    } else {
      // Switching to source — grab current HTML
      setSourceHtml(editor.getHTML());
      setShowSource(true);
    }
  };

  const addLink = () => {
    const url = window.prompt(t('blog.editor.enterUrl'));
    if (url) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  };

  const addImage = () => {
    const url = window.prompt(t('blog.editor.enterImageUrl'));
    if (url) {
      editor.chain().focus().setImage({ src: url }).run();
    }
  };

  const addVideo = () => {
    const url = window.prompt(t('blog.editor.enterVideoUrl'));
    if (url) {
      editor.chain().focus().setYoutubeVideo({ src: url }).run();
    }
  };

  if (loading) return <div className="blog-loading">{t('blog.loading')}</div>;

  return (
    <div className="blog-editor-page">
      <div className="blog-editor-header">
        <h1>{isNew ? t('blog.editor.newPost') : t('blog.editor.editPost')}</h1>
        <div className="blog-editor-actions">
          <button className="btn btn-secondary" onClick={() => navigate('/admin/blog')} disabled={saving}>
            {t('blog.admin.cancel')}
          </button>
          <button className="btn btn-secondary" onClick={() => handleSave('draft')} disabled={saving}>
            {t('blog.editor.saveDraft')}
          </button>
          <button className="btn btn-primary" onClick={() => handleSave('published')} disabled={saving}>
            {t('blog.editor.publish')}
          </button>
        </div>
      </div>

      <div className="blog-editor-layout">
        <div className="blog-editor-main">
          <input
            type="text"
            className="blog-editor-title-input"
            placeholder={t('blog.editor.titlePlaceholder')}
            value={title}
            onChange={e => setTitle(e.target.value)}
          />

          {editor && (
            <div className="blog-editor-toolbar">
              <button onClick={() => editor.chain().focus().toggleBold().run()} className={editor.isActive('bold') ? 'active' : ''} title="Bold">
                <strong>B</strong>
              </button>
              <button onClick={() => editor.chain().focus().toggleItalic().run()} className={editor.isActive('italic') ? 'active' : ''} title="Italic">
                <em>I</em>
              </button>
              <button onClick={() => editor.chain().focus().toggleUnderline().run()} className={editor.isActive('underline') ? 'active' : ''} title="Underline">
                <u>U</u>
              </button>
              <div className="toolbar-divider" />
              <button onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={editor.isActive('heading', { level: 2 }) ? 'active' : ''} title="Heading 2">
                H2
              </button>
              <button onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} className={editor.isActive('heading', { level: 3 }) ? 'active' : ''} title="Heading 3">
                H3
              </button>
              <div className="toolbar-divider" />
              <button onClick={() => editor.chain().focus().toggleBulletList().run()} className={editor.isActive('bulletList') ? 'active' : ''} title="Bullet list">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>
              </button>
              <button onClick={() => editor.chain().focus().toggleOrderedList().run()} className={editor.isActive('orderedList') ? 'active' : ''} title="Ordered list">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="2" y="8" fontSize="8" fill="currentColor" stroke="none" fontFamily="sans-serif">1</text><text x="2" y="14" fontSize="8" fill="currentColor" stroke="none" fontFamily="sans-serif">2</text><text x="2" y="20" fontSize="8" fill="currentColor" stroke="none" fontFamily="sans-serif">3</text></svg>
              </button>
              <button onClick={() => editor.chain().focus().toggleBlockquote().run()} className={editor.isActive('blockquote') ? 'active' : ''} title="Quote">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z"/></svg>
              </button>
              <div className="toolbar-divider" />
              <button onClick={addLink} className={editor.isActive('link') ? 'active' : ''} title="Add link">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              </button>
              {editor.isActive('link') && (
                <button onClick={() => editor.chain().focus().unsetLink().run()} title="Remove link">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                </button>
              )}
              <button onClick={addImage} title="Add image">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              </button>
              <button onClick={addVideo} title="Add YouTube video">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </button>
              <div className="toolbar-divider" />
              <button onClick={() => editor.chain().focus().setTextAlign('left').run()} className={editor.isActive({ textAlign: 'left' }) ? 'active' : ''} title="Align left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="17" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>
              </button>
              <button onClick={() => editor.chain().focus().setTextAlign('center').run()} className={editor.isActive({ textAlign: 'center' }) ? 'active' : ''} title="Align center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="18" y1="14" x2="6" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>
              </button>
              <div className="toolbar-divider" />
              <button onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal rule">
                —
              </button>
              <button onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title="Undo">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              </button>
              <button onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title="Redo">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
              </button>
              <div className="toolbar-divider" />
              <button onClick={toggleSource} className={showSource ? 'active' : ''} title={t('blog.editor.sourceCode')}>
                &lt;/&gt;
              </button>
            </div>
          )}

          <div className="blog-editor-content">
            {showSource ? (
              <textarea
                className="blog-editor-source"
                value={sourceHtml}
                onChange={e => setSourceHtml(e.target.value)}
                spellCheck={false}
              />
            ) : (
              <EditorContent editor={editor} />
            )}
          </div>
        </div>

        <aside className="blog-editor-sidebar">
          <div className="blog-editor-field">
            <label>{t('blog.editor.excerpt')}</label>
            <textarea
              value={excerpt}
              onChange={e => setExcerpt(e.target.value)}
              placeholder={t('blog.editor.excerptPlaceholder')}
              maxLength={500}
              rows={3}
            />
          </div>

          <div className="blog-editor-field">
            <label>{t('blog.editor.coverImage')}</label>
            <input
              type="url"
              value={coverImage}
              onChange={e => setCoverImage(e.target.value)}
              placeholder="https://..."
            />
            {coverImage && (() => {
              try {
                const parsed = new URL(coverImage);
                if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
                  return <img src={parsed.href} alt="Cover preview" className="blog-editor-cover-preview" />;
                }
              } catch { /* invalid URL */ }
              return null;
            })()}
          </div>

          <div className="blog-editor-field">
            <label>{t('blog.editor.tags')}</label>
            <input
              type="text"
              value={tagsInput}
              onChange={e => setTagsInput(e.target.value)}
              placeholder={t('blog.editor.tagsPlaceholder')}
            />
          </div>

          <details className="blog-editor-seo">
            <summary>{t('blog.editor.seoSettings')}</summary>
            <div className="blog-editor-field">
              <label>{t('blog.editor.metaTitle')}</label>
              <input
                type="text"
                value={metaTitle}
                onChange={e => setMetaTitle(e.target.value)}
                placeholder={title || t('blog.editor.metaTitlePlaceholder')}
                maxLength={70}
              />
              <span className="blog-editor-charcount">{metaTitle.length}/70</span>
            </div>
            <div className="blog-editor-field">
              <label>{t('blog.editor.metaDescription')}</label>
              <textarea
                value={metaDescription}
                onChange={e => setMetaDescription(e.target.value)}
                placeholder={t('blog.editor.metaDescriptionPlaceholder')}
                maxLength={160}
                rows={2}
              />
              <span className="blog-editor-charcount">{metaDescription.length}/160</span>
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}

export default AdminBlogEditor;
