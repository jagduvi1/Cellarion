function Unsubscribed() {
  return (
    <div style={{ maxWidth: 480, margin: '4rem auto', padding: '2rem', textAlign: 'center' }}>
      <h1>Unsubscribed</h1>
      <p>You have been unsubscribed from all Cellarion email notifications.</p>
      <p>
        You can re-enable notifications at any time from{' '}
        <a href="/settings">Settings</a>.
      </p>
    </div>
  );
}

export default Unsubscribed;
