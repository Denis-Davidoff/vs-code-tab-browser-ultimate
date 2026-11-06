import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {chatProjectId,legacyProjectTabs} from './chatProject.ts';

test('project identity separates folders, named workspaces, remote hosts and empty windows',()=>{
 const a=chatProjectId(undefined,['file:///projects/A']);
 assert.equal(chatProjectId(undefined,['file:///projects/A']),a);
 assert.notEqual(chatProjectId(undefined,['file:///projects/B']),a);
 assert.notEqual(chatProjectId(undefined,['vscode-remote://ssh-remote+server/projects/A']),a);
 assert.notEqual(chatProjectId('file:///one.code-workspace',['file:///projects/A']),chatProjectId('file:///two.code-workspace',['file:///projects/A']));
 assert.notEqual(chatProjectId(undefined,[],'empty-one'),chatProjectId(undefined,[],'empty-two'));
});

test('folder ordering is stable and a workspace file remains the project when its roots change',()=>{
 assert.equal(chatProjectId(undefined,['file:///b','file:///a']),chatProjectId(undefined,['file:///a','file:///b']));
 assert.equal(chatProjectId('file:///project.code-workspace',['file:///a']),chatProjectId('file:///project.code-workspace',['file:///b']));
});

test('legacy migration keeps tabs working in external folders and managed copies',()=>{
 const saved={ids:['root','copy','elsewhere'],folders:{root:'/project/sub',copy:'/storage/github/o/r/copies/b',elsewhere:'/other'},fresh:['root','copy','elsewhere'],active:'copy'};
 const migrated=legacyProjectTabs(saved,'project');
 assert.deepEqual(migrated?.ids,['root','copy','elsewhere']);
 assert.equal(migrated?.active,'copy');assert.equal(migrated?.project,'project');
 assert.deepEqual(saved.ids,['root','copy','elsewhere'],'the saved record is not modified');
});

test('legacy migration serves an empty window and drops what cannot be a chat id',()=>{
 const migrated=legacyProjectTabs({ids:['a',7,null,'b'],folders:{a:'/anywhere'},active:'gone'},'empty');
 assert.deepEqual(migrated?.ids,['a','b']);assert.equal(migrated?.active,undefined);
 assert.deepEqual(legacyProjectTabs({},'p')?.ids,[]);
 assert.equal(legacyProjectTabs(undefined,'p'),undefined);
});

test('a snapshot stamped for another project is not adopted',()=>{
 assert.equal(legacyProjectTabs({project:'foreign',ids:['a']},'project'),undefined);
 assert.deepEqual(legacyProjectTabs({project:'project',ids:['a']},'project')?.ids,['a']);
});

test('tabProject groups by folder, copies by repository, and hides paths', async () => {
	const { tabProject } = await import('./chatProject.ts');
	const a = tabProject('/Users/x/dev/picto', undefined, false);
	assert.equal(a.name, 'picto');
	assert.equal(tabProject('/Users/x/dev/picto/', undefined, false).id, a.id);
	assert.notEqual(tabProject('/Users/x/dev/other', undefined, false).id, a.id);
	assert.ok(!a.id.includes('picto'));
	const c1 = tabProject('/storage/copies/a-1', 'Octo/Hello', false);
	assert.equal(c1.name, 'Hello');
	assert.equal(tabProject('/storage/copies/b-2', 'octo/hello', false).id, c1.id);
	assert.deepEqual(tabProject('/Users/x', undefined, true), { id: 'home', name: 'Home' });
	assert.equal(tabProject('C:\\dev\\app', undefined, false).name, 'app');
});
