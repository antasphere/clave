"""Ephemeral hosted-CI image evidence. No local engine work on import."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

OWNER_LABEL = 'com.clave.ci.owner'
SHA256 = re.compile(r'sha256:[0-9a-f]{64}')
COMMIT = re.compile(r'[0-9a-f]{40}')


def run(argv, timeout=20):
    return subprocess.check_output(argv, text=True, timeout=timeout).strip()


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def owner():
    value = f"relay-image-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    assert re.fullmatch(r'relay-image-\d+-\d+', value)
    return value


def evidence():
    return Path(os.environ['RELAY_EVIDENCE'])


def validate_source(checked_out, tree, parents, event_sha, head, base):
    assert all(COMMIT.fullmatch(x) for x in [checked_out, tree, head, base])
    assert checked_out == event_sha, 'Checkout differs from event merge'
    assert parents == [base, head], 'Actual tested merge parents differ from PR source'


def validate_image(iid, inspected, metadata, source_sha):
    assert SHA256.fullmatch(iid), 'Invalid image ID'
    assert inspected['Id'] == iid == metadata['containerimage.config.digest'], 'Image identity differs'
    assert inspected['Os'] == 'linux' and inspected['Architecture'] == 'amd64', 'Wrong platform'
    assert inspected['Config']['Labels']['org.opencontainers.image.revision'] == source_sha
    descriptor = metadata['containerimage.descriptor']
    assert SHA256.fullmatch(metadata['containerimage.digest']), 'Missing immutable manifest digest'
    assert descriptor['digest'] == metadata['containerimage.digest'], 'Manifest descriptor differs'
    assert descriptor['mediaType'] in (
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json'
    ), 'Expected one platform manifest'


def validate_smoke(health, unauthorized_status):
    assert health == {'status': 'live', 'machines': 0, 'online': 0}, 'Relay health differs'
    assert unauthorized_status == 401, 'Unauthenticated machine listing was not refused'


def validate_dependencies(embedded, expected):
    assert embedded == expected, 'Embedded dependency provenance differs from tested source'


def validate_owned_container(value, expected_owner, expected_id=None):
    cid = value['Id']
    assert re.fullmatch(r'[0-9a-f]{64}', cid), 'Invalid container ID'
    assert expected_id is None or cid == expected_id, 'Container ID differs'
    assert value['Name'] == '/' + expected_owner, 'Container name differs'
    assert value['Config']['Labels'].get(OWNER_LABEL) == expected_owner, 'Foreign container'
    return cid


def source():
    out = evidence()
    out.mkdir(mode=0o700)
    assert os.environ['RELAY_PLATFORM'] == 'linux/amd64'
    assert run(['git', 'status', '--porcelain', '--untracked-files=all']) == ''
    checked_out = run(['git', 'rev-parse', 'HEAD'])
    tree = run(['git', 'rev-parse', 'HEAD^{tree}'])
    parents = run(['git', 'show', '-s', '--format=%P', 'HEAD']).split()
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    pr = event['pull_request']
    head, base = pr['head']['sha'], pr['base']['sha']
    validate_source(checked_out, tree, parents, os.environ['GITHUB_SHA'], head, base)
    value = {
        'checkoutSha': checked_out, 'testedTree': tree, 'parents': parents,
        'prHead': head, 'prBase': base, 'prNumber': pr['number'],
        'eventSha': os.environ['GITHUB_SHA'], 'runId': os.environ['GITHUB_RUN_ID'],
        'attempt': os.environ['GITHUB_RUN_ATTEMPT'], 'platform': 'linux/amd64',
        'rootLockBlob': run(['git', 'rev-parse', 'HEAD:package-lock.json']),
        'rootLockSha256': digest(Path('package-lock.json')),
        'dockerfileBlob': run(['git', 'rev-parse', 'HEAD:packages/server/relay.Dockerfile']),
        'dockerfileSha256': digest(Path('packages/server/relay.Dockerfile')),
        'runnerImageOS': os.environ.get('ImageOS'), 'runnerImageVersion': os.environ.get('ImageVersion')
    }
    write(out / 'source.json', value)
    print(json.dumps(value, indent=2), flush=True)
    run(['git', 'archive', '--format=tar', '--output=' + str(out / 'context.tar'), checked_out], 30)
    value['contextSha256'] = digest(out / 'context.tar')
    write(out / 'source.json', value)
    run(['node', 'packages/server/relay-dependencies.mjs', 'package-lock.json',
         'packages/server/relay.package.json', str(out / 'expected-dependencies')], 15)


def build():
    out = evidence()
    src = json.loads((out / 'source.json').read_text())
    assert digest(out / 'context.tar') == src['contextSha256']
    (out / 'docker-version.txt').write_text(run(['docker', 'version'], 15) + '\n')
    (out / 'buildx-version.txt').write_text(run(['docker', 'buildx', 'version'], 15) + '\n')
    argv = ['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--no-cache',
            '--provenance=false', '--sbom=false', '--load',
            '--metadata-file', str(out / 'build-metadata.json'),
            '--iidfile', str(out / 'image-id'),
            '--label', 'org.opencontainers.image.revision=' + src['checkoutSha'],
            '--tag', 'clave-relay-ci:' + owner(), '--file', 'packages/server/relay.Dockerfile', '-']
    write(out / 'build-command.json', argv)
    with (out / 'context.tar').open('rb') as archive, (out / 'build.log').open('wb') as log:
        subprocess.run(argv, stdin=archive, stdout=log, stderr=subprocess.STDOUT,
                       timeout=420, check=True)
    iid = (out / 'image-id').read_text().strip()
    inspected = json.loads(run(['docker', 'image', 'inspect', iid], 15))[0]
    metadata = json.loads((out / 'build-metadata.json').read_text())
    validate_image(iid, inspected, metadata, src['checkoutSha'])
    write(out / 'image-inspect.json', inspected)
    print(json.dumps({'imageId': iid, 'manifestDigest': metadata['containerimage.digest'],
                      'platform': 'linux/amd64'}), flush=True)


def request(url):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.status, response.read(65537)
    except urllib.error.HTTPError as error:
        return error.code, error.read(65537)


def smoke():
    out = evidence()
    iid = (out / 'image-id').read_text().strip()
    assert SHA256.fullmatch(iid)
    (out / 'create-attempted').write_text(owner() + '\n')
    cid = run(['docker', 'create', '--cidfile', str(out / 'container-id'),
               '--name', owner(), '--label', OWNER_LABEL + '=' + owner(),
               '--publish', '127.0.0.1::8787', '--env',
               'RELAY_ISSUER=https://account.antasphere.com', iid], 15)
    assert cid == (out / 'container-id').read_text().strip()
    created = json.loads(run(['docker', 'container', 'inspect', cid], 10))[0]
    validate_owned_container(created, owner(), cid)
    assert created['Image'] == iid, 'Created container uses another image'
    run(['docker', 'start', cid], 15)
    started = json.loads(run(['docker', 'container', 'inspect', cid], 10))[0]
    validate_owned_container(started, owner(), cid)
    assert started['Image'] == iid, 'Started container uses another image'
    write(out / 'container-inspect.json', started)
    ports = started['NetworkSettings']['Ports']['8787/tcp']
    assert len(ports) == 1 and ports[0]['HostIp'] == '127.0.0.1'
    port = ports[0]['HostPort']
    assert port.isdigit() and 0 < int(port) < 65536
    base = 'http://127.0.0.1:' + port
    deadline = time.monotonic() + 30
    while True:
        try:
            status, raw = request(base + '/health')
            if status == 200:
                health = json.loads(raw)
                break
        except (OSError, ValueError):
            pass
        assert time.monotonic() < deadline, 'Relay did not become healthy within 30 seconds'
        time.sleep(.25)
    unauthorized, raw = request(base + '/machines')
    validate_smoke(health, unauthorized)
    run(['docker', 'cp', cid + ':/app/relay-dependencies.json',
         str(out / 'embedded-relay-dependencies.json')], 15)
    embedded = json.loads((out / 'embedded-relay-dependencies.json').read_text())
    expected = json.loads((out / 'expected-dependencies/relay-dependencies.json').read_text())
    validate_dependencies(embedded, expected)
    write(out / 'smoke.json', {'health': health, 'unauthenticatedMachinesStatus': unauthorized,
                              'embeddedDependenciesMatch': True, 'containerId': cid,
                              'owner': owner(), 'imageId': iid, 'loopbackPort': int(port)})


def archive():
    out = evidence()
    iid = (out / 'image-id').read_text().strip()
    assert SHA256.fullmatch(iid)
    run(['docker', 'image', 'save', '--output', str(out / 'image.docker-archive.tar'), iid], 90)


def cleanup():
    out = evidence()
    if not out.exists():
        return
    result = {'owner': owner(), 'removed': False, 'status': 'NO CONTAINER CREATE ATTEMPT'}
    if not (out / 'create-attempted').exists():
        write(out / 'cleanup.json', result)
        return
    try:
        cidfile = out / 'container-id'
        expected_id = cidfile.read_text().strip() if cidfile.exists() else None
        if expected_id is not None:
            assert re.fullmatch(r'[0-9a-f]{64}', expected_id)
        # Recover only our exact unique name if create was interrupted before cidfile persistence.
        value = json.loads(run(['docker', 'container', 'inspect', expected_id or owner()], 10))[0]
        cid = validate_owned_container(value, owner(), expected_id)
        try:
            with (out / 'container.log').open('w') as log:
                logs = subprocess.run(['docker', 'logs', '--tail', '100', cid], stdout=log,
                                      stderr=subprocess.STDOUT, timeout=5, check=False)
                result['logsExit'] = logs.returncode
        except subprocess.TimeoutExpired:
            result['logsTimedOut'] = True
        run(['docker', 'container', 'rm', '--force', '--volumes', cid], 15)
        probe = subprocess.run(['docker', 'container', 'inspect', cid],
                               capture_output=True, text=True, timeout=5)
        assert probe.returncode != 0 and 'No such' in probe.stderr, 'Removal unconfirmed'
        result.update(status='OWNED CONTAINER REMOVED', removed=True, containerId=cid)
    except Exception as error:
        result.update(status='UNKNOWN; NO FOREIGN CLEANUP', error=type(error).__name__)
        raise
    finally:
        write(out / 'cleanup.json', result)


def manifest():
    out = evidence()
    if not out.exists():
        return
    if (out / 'source.json').exists():
        src = json.loads((out / 'source.json').read_text())
        after = {'checkoutSha': run(['git', 'rev-parse', 'HEAD']),
                 'testedTree': run(['git', 'rev-parse', 'HEAD^{tree}']),
                 'status': run(['git', 'status', '--porcelain', '--untracked-files=all']),
                 'rootLockSha256': digest(Path('package-lock.json'))}
        write(out / 'after-source.json', after)
        assert after == {'checkoutSha': src['checkoutSha'], 'testedTree': src['testedTree'],
                         'status': '', 'rootLockSha256': src['rootLockSha256']}, 'Source changed'
    write(out / 'artifact-hashes.json', {
        str(p.relative_to(out)): {'sha256': digest(p), 'bytes': p.stat().st_size}
        for p in out.rglob('*') if p.is_file() and p.name != 'artifact-hashes.json'
    })


if __name__ == '__main__':
    commands = {'source': source, 'build': build, 'smoke': smoke,
                'archive': archive, 'cleanup': cleanup, 'manifest': manifest}
    assert len(sys.argv) == 2 and sys.argv[1] in commands
    commands[sys.argv[1]]()
