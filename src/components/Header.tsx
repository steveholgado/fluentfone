export function Header() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between px-4">
      <div className="text-xl">Logo</div>
      <button
        type="button"
        className="cursor-pointer rounded-lg bg-gray-200 px-4 py-1.5 text-base text-black hover:bg-gray-300"
      >
        Menu
      </button>
    </header>
  );
}
