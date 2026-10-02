// The package ships Emscripten's UMD glue with no types, and a `main` that
// points nowhere (`/build/piper_phonemize.js`, from the filesystem root), so
// piper.ts imports the file itself. Only what piper.ts uses is declared.
declare module '@diffusionstudio/piper-wasm/build/piper_phonemize.js' {
  interface PiperPhonemizeOptions {
    /** Each line the program writes to stdout. */
    print?: (line: string) => void;
    /** Each line the program writes to stderr. */
    printErr?: (line: string) => void;
    /** Maps the .wasm and .data file names to the URLs to fetch them from. */
    locateFile?: (path: string) => string;
  }

  interface PiperPhonemizeModule {
    /** Runs the program's `main` to completion, and returns its exit code. */
    callMain(args: string[]): number;
  }

  const createPiperPhonemize: (
    options?: PiperPhonemizeOptions,
  ) => Promise<PiperPhonemizeModule>;

  export default createPiperPhonemize;
}
