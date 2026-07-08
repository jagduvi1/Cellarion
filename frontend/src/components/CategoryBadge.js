import { useTranslation } from 'react-i18next';
import './CategoryBadge.css';

const CATEGORY_SLUGS = [
  'tasting-notes',
  'food-pairing',
  'recommendations',
  'cellar-tips',
  'general'
];

export default function CategoryBadge({ category, onClick }) {
  const { t } = useTranslation();
  const label = CATEGORY_SLUGS.includes(category)
    ? t(`discussions.categories.${category}`)
    : category;
  const Tag = onClick ? 'button' : 'span';

  return (
    <Tag
      className={`category-badge category-badge--${category}`}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
    >
      {label}
    </Tag>
  );
}

export { CATEGORY_SLUGS };
