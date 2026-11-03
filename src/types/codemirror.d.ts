// Local declarations so type-checking works without @types packages installed.
declare module 'codemirror' { const CodeMirror: unknown; export default CodeMirror; }
declare module 'codemirror/addon/*';
declare module '*.css';
