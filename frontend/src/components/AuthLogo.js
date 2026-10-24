import '../pages/Login.css';

// The current Cellarion logo at the top of the sign-in style cards: log in,
// register, forgot and reset password, verify email, and the delete-account
// link page. One component, so they all show the same logo.
const LOGO_WEBP = '/cellarion-logo-light.webp';
const LOGO_PNG = '/cellarion-logo-light.png';

function AuthLogo() {
  return (
    <picture>
      <source srcSet={LOGO_WEBP} type="image/webp" />
      <img src={LOGO_PNG} alt="Cellarion" className="login-logo" width="159" height="128" />
    </picture>
  );
}

export default AuthLogo;
