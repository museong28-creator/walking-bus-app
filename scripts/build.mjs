import {cp,mkdir,rm} from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});
await mkdir('dist',{recursive:true});
for (const name of ['index.html','styles.css','src','assets','manifest.webmanifest','sw.js','docs']) {
  await cp(name,`dist/${name}`,{recursive:true});
}
console.log('Static GitHub Pages files built in dist/.');
