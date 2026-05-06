import { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
};

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState(() => {
    // Light is the brand default. Cellarion's colour system, photography, and
    // wine-label imagery are designed for the warm cream palette — first-time
    // visitors see that even when their OS is in dark mode. Returning users
    // get whatever they last chose via the toggle.
    const saved = localStorage.getItem('cellarion-theme');
    return saved || 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('cellarion-theme', theme);

    // Update theme-color meta tag
    const metaLight = document.querySelector('meta[name="theme-color"][media*="light"]');
    const metaDark = document.querySelector('meta[name="theme-color"][media*="dark"]');
    if (theme === 'dark') {
      if (metaLight) metaLight.setAttribute('content', '#121212');
      if (metaDark) metaDark.setAttribute('content', '#121212');
    } else {
      if (metaLight) metaLight.setAttribute('content', '#FAF8F6');
      if (metaDark) metaDark.setAttribute('content', '#FAF8F6');
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};
