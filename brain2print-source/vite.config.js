import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  base: './',
  define: { __B2P_CAPTURE__: 'false' },
  build: { outDir: '../vendor/brain2print', emptyOutDir: true, rollupOptions: { input: {
    main: fileURLToPath(new URL('./index.html', import.meta.url)),
    context: fileURLToPath(new URL('./context.html', import.meta.url))
  } } },
  worker: { format: 'esm' },
  optimizeDeps: { exclude: ['@itk-wasm/cuberille', '@itk-wasm/mesh-filters'] },
  plugins: [viteStaticCopy({ targets: [
    { src: 'node_modules/@itk-wasm/cuberille/dist/pipelines/*.{js,wasm,wasm.zst}', dest: 'pipelines' },
    { src: 'node_modules/@itk-wasm/mesh-filters/dist/pipelines/*.{js,wasm,wasm.zst}', dest: 'pipelines' }
  ] })]
});
