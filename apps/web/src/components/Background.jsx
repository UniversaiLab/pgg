/** Two slow red glows behind the lobby and login. Transform-only animation, so it stays cheap. */
export function Background() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="orb orb-a" />
      <div className="orb orb-b" />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/30 to-black" />
    </div>
  );
}
