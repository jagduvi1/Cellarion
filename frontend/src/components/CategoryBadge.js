import './CategoryBadge.css';

const CATEGORY_LABELS = {
  'tasting-notes': 'Tasting Notes',
  'food-pairing': 'Food Pairing',
  'recommendations': 'Recommendations',
  'cellar-tips': 'Cellar Tips',
  'general': 'General'
};

export default function CategoryBadge({ category, onClick }) {
  const label = CATEGORY_LABELS[category] || category;
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

export { CATEGORY_LABELS };
