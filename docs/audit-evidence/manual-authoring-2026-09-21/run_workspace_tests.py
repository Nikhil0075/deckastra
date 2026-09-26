import json, pathlib, shlex, subprocess
root = pathlib.Path(__file__).resolve().parents[2]
out = root / '.next/manual-authoring-review'
results = []
paths = sorted((root / 'packages').glob('*/package.json')) + [root/'apps'/x/'package.json' for x in ('desktop','mcp-server','web','worker')]
for path in paths:
    package = json.loads(path.read_text(encoding='utf-8'))
    command = package.get('scripts', {}).get('test', '')
    if not command.startswith('vitest run') or package['name'] == '@deckastra/editor-ui':
        continue
    args = ['node', str(root/'node_modules/vitest/vitest.mjs'), *shlex.split(command)[1:], '--maxWorkers=1', '--no-file-parallelism']
    log = out / (package['name'].replace('@deckastra/', '') + '-test.log')
    with log.open('w', encoding='utf-8') as output:
        result = subprocess.run(args, cwd=path.parent, stdout=output, stderr=subprocess.STDOUT)
    results.append({'workspace':package['name'], 'exitCode':result.returncode, 'log':log.name})
    (out/'workspace-results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(package['name'], result.returncode, flush=True)
