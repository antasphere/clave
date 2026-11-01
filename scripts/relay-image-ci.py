"""Ephemeral hosted-CI image evidence. No local engine work on import."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

OWNER_LABEL = 'com.clave.ci.owner'
SHA256 = re.compile(r'sha256:[0-9a-f]{64}')
COMMIT = re.compile(r'[0-9a-f]{40}')
TARGET_INPUTS = ('package-lock.json', 'packages/server/relay.package.json',
                 'packages/server/relay-dependencies.mjs',
                 'packages/server/relay.Dockerfile', '.dockerignore')


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
    return Path(os.environ['RELAY_EVIDENCE']).resolve()


def validate_source(checked_out, tree, parents, event_sha, head, base):
    assert all(COMMIT.fullmatch(x) for x in [checked_out, tree, head, base])
    assert checked_out == event_sha, 'Checkout differs from event merge'
    assert parents == [base, head], 'Actual tested merge parents differ from PR source'


def validate_target(actual_sha, actual_tree, expected_sha, expected_tree):
    assert all(isinstance(x, str) and COMMIT.fullmatch(x)
               for x in [actual_sha, actual_tree, expected_sha, expected_tree]), \
        'Target requires full immutable commit and tree pins'
    assert actual_sha == expected_sha, 'Target commit differs from required source'
    assert actual_tree == expected_tree, 'Target tree differs from required source'


def target():
    sha, tree = os.environ.get('RELAY_TARGET_SHA'), os.environ.get('RELAY_TARGET_TREE')
    # Validate before putting a supplied revision into any Git command.
    validate_target(sha, tree, sha, tree)
    actual_sha = run(['git', 'rev-parse', sha + '^{commit}'])
    actual_tree = run(['git', 'rev-parse', sha + '^{tree}'])
    validate_target(actual_sha, actual_tree, sha, tree)
    return sha, tree


def target_inputs(archive_path, sha):
    inputs, contents = {}, {}
    with tarfile.open(archive_path) as archive:
        for name in TARGET_INPUTS:
            members = [m for m in archive.getmembers() if m.name == name]
            assert len(members) == 1 and members[0].isfile(), 'Ambiguous target input: ' + name
            data = archive.extractfile(members[0]).read()
            blob = run(['git', 'rev-parse', sha + ':' + name])
            actual_blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            assert actual_blob == blob, 'Archive input differs from target blob: ' + name
            inputs[name] = {'blob': blob, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
            contents[name] = data
    return inputs, contents


def bound_source():
    """Recheck both bindings before any engine command, including on resumed steps."""
    out = evidence()
    src = json.loads((out / 'source.json').read_text())
    assert src['schemaVersion'] == 2, 'Unbound legacy source receipt'
    sha, tree = target()
    validate_target(src['targetSha'], src['targetTree'], sha, tree)
    assert run(['git', 'rev-parse', 'HEAD']) == src['checkoutSha'], 'Controller commit changed'
    assert run(['git', 'rev-parse', 'HEAD^{tree}']) == src['testedTree'], 'Controller tree changed'
    assert run(['git', 'status', '--porcelain', '--untracked-files=all']) == '', 'Controller is dirty'
    context = out / 'context.tar'
    assert digest(context) == src['contextSha256'], 'Target context changed'
    # A forged receipt/hash for a controller archive must not rebind the target.
    with tempfile.TemporaryDirectory(dir=out) as directory:
        canonical = Path(directory) / 'context.tar'
        run(['git', 'archive', '--format=tar', '--output=' + str(canonical), sha], 30)
        assert digest(context) == digest(canonical), 'Archive is not the immutable target'
    inputs, _ = target_inputs(context, sha)
    assert inputs == src['targetInputs'], 'Target input receipt differs'
    assert src['rootLockBlob'] == inputs['package-lock.json']['blob']
    assert src['rootLockSha256'] == inputs['package-lock.json']['sha256']
    assert src['dockerfileBlob'] == inputs['packages/server/relay.Dockerfile']['blob']
    assert src['dockerfileSha256'] == inputs['packages/server/relay.Dockerfile']['sha256']
    assert digest(out / 'expected-dependencies/relay-dependencies.json') == \
        src['expectedDependenciesSha256'], 'Expected dependency projection changed'
    return src


def image_labels(src):
    return {'org.opencontainers.image.revision': src['targetSha'],
            'com.clave.target.tree': src['targetTree'],
            'com.clave.target.context-sha256': src['contextSha256'],
            'com.clave.controller.revision': src['checkoutSha']}


def validate_image(iid, inspected, metadata, src):
    assert SHA256.fullmatch(iid), 'Invalid image ID'
    assert inspected['Id'] == iid == metadata['containerimage.config.digest'], 'Image identity differs'
    assert inspected['Os'] == 'linux' and inspected['Architecture'] == 'amd64', 'Wrong platform'
    for name, value in image_labels(src).items():
        assert inspected['Config']['Labels'].get(name) == value, 'Image binding differs: ' + name
    exported = metadata['containerimage.digest']
    assert SHA256.fullmatch(exported), 'Invalid exporter digest'
    identity = {'imageId': iid, 'configDigest': iid, 'exporterDigest': exported,
                'platform': 'linux/amd64', 'sourceBindings': image_labels(src)}
    if 'containerimage.descriptor' not in metadata:
        assert exported == iid, 'Descriptor missing for a non-config exporter digest'
        return {**identity, 'kind': 'image-config',
                'manifestDigest': None, 'manifestMediaType': None}
    descriptor = metadata['containerimage.descriptor']
    assert isinstance(descriptor, dict), 'Malformed supplied manifest descriptor'
    assert descriptor.get('digest') == exported != iid, 'Manifest descriptor differs from its identity'
    assert descriptor.get('mediaType') in (
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json'
    ), 'Expected one platform manifest'
    return {**identity, 'kind': 'manifest', 'manifestDigest': exported,
            'manifestMediaType': descriptor['mediaType']}


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


def validate_absence(probe, cid):
    assert re.fullmatch(r'[0-9a-f]{64}', cid)
    supported = {
        f'{prefix} No such {kind}: {cid}'
        for prefix in ['Error:', 'Error response from daemon:']
        for kind in ['container', 'object']
    }
    assert probe.returncode != 0 and probe.stdout.strip() == '[]' and \
        probe.stderr.strip() in supported, 'Exact owned container removal unconfirmed'


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
    target_sha, target_tree = target()
    run(['git', 'archive', '--format=tar', '--output=' + str(out / 'context.tar'), target_sha], 30)
    inputs, contents = target_inputs(out / 'context.tar', target_sha)
    staged = out / 'target-inputs'
    staged.mkdir()
    for name, data in contents.items():
        (staged / Path(name).name).write_bytes(data)
    # These inputs come from the exact archived target, never the controller checkout.
    run(['node', str(staged / 'relay-dependencies.mjs'), str(staged / 'package-lock.json'),
         str(staged / 'relay.package.json'), str(out / 'expected-dependencies')], 15)
    value = {
        'schemaVersion': 2, 'targetSha': target_sha, 'targetTree': target_tree,
        'targetInputs': inputs, 'contextSha256': digest(out / 'context.tar'),
        'expectedDependenciesSha256': digest(out / 'expected-dependencies/relay-dependencies.json'),
        'checkoutSha': checked_out, 'testedTree': tree, 'parents': parents,
        'prHead': head, 'prBase': base, 'prNumber': pr['number'],
        'eventSha': os.environ['GITHUB_SHA'], 'runId': os.environ['GITHUB_RUN_ID'],
        'attempt': os.environ['GITHUB_RUN_ATTEMPT'], 'platform': 'linux/amd64',
        'rootLockBlob': inputs['package-lock.json']['blob'],
        'rootLockSha256': inputs['package-lock.json']['sha256'],
        'dockerfileBlob': inputs['packages/server/relay.Dockerfile']['blob'],
        'dockerfileSha256': inputs['packages/server/relay.Dockerfile']['sha256'],
        'runnerImageOS': os.environ.get('ImageOS'), 'runnerImageVersion': os.environ.get('ImageVersion')
    }
    write(out / 'source.json', value)
    print(json.dumps(value, indent=2), flush=True)


def build():
    out = evidence()
    src = bound_source()
    (out / 'docker-version.txt').write_text(run(['docker', 'version'], 15) + '\n')
    (out / 'buildx-version.txt').write_text(run(['docker', 'buildx', 'version'], 15) + '\n')
    argv = ['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--no-cache',
            '--provenance=false', '--sbom=false', '--load',
            '--metadata-file', str(out / 'build-metadata.json'),
            '--iidfile', str(out / 'image-id'),
            '--tag', 'clave-relay-ci:' + owner(), '--file', 'packages/server/relay.Dockerfile']
    for name, value in image_labels(src).items():
        argv.extend(['--label', name + '=' + value])
    argv.append('-')
    write(out / 'build-command.json', argv)
    with (out / 'context.tar').open('rb') as archive, (out / 'build.log').open('wb') as log:
        subprocess.run(argv, stdin=archive, stdout=log, stderr=subprocess.STDOUT,
                       timeout=420, check=True)
    iid = (out / 'image-id').read_text().strip()
    assert SHA256.fullmatch(iid), 'Invalid built image ID'
    raw_inspection = run(['docker', 'image', 'inspect', iid], 15)
    (out / 'image-inspect.json').write_text(raw_inspection + '\n')
    inspections = json.loads(raw_inspection)
    assert isinstance(inspections, list) and len(inspections) == 1, 'Ambiguous image inspection'
    inspected = inspections[0]
    metadata = json.loads((out / 'build-metadata.json').read_text())
    identity = validate_image(iid, inspected, metadata, src)
    write(out / 'image-identity.json', identity)
    print(json.dumps(identity), flush=True)


def request(url):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.status, response.read(65537)
    except urllib.error.HTTPError as error:
        return error.code, error.read(65537)


def smoke():
    out = evidence()
    src = bound_source()
    iid = (out / 'image-id').read_text().strip()
    assert SHA256.fullmatch(iid)
    validate_stored_image(out, src, iid)
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
    src = bound_source()
    iid = (out / 'image-id').read_text().strip()
    assert SHA256.fullmatch(iid)
    validate_stored_image(out, src, iid)
    run(['docker', 'image', 'save', '--output', str(out / 'image.docker-archive.tar'), iid], 90)


def validate_stored_image(out, src, iid):
    inspections = json.loads((out / 'image-inspect.json').read_text())
    assert isinstance(inspections, list) and len(inspections) == 1, 'Ambiguous image inspection'
    metadata = json.loads((out / 'build-metadata.json').read_text())
    identity = validate_image(iid, inspections[0], metadata, src)
    assert identity == json.loads((out / 'image-identity.json').read_text()), 'Image receipt changed'


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
        except Exception as error:
            # Diagnostic I/O must not prevent removal of an already validated own CID.
            result['logsError'] = f'{type(error).__name__}: {str(error)[:400]}'
        run(['docker', 'container', 'rm', '--force', '--volumes', cid], 15)
        probe = subprocess.run(['docker', 'container', 'inspect', cid],
                               capture_output=True, text=True, timeout=5)
        validate_absence(probe, cid)
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
        src = bound_source()
        after = {'checkoutSha': run(['git', 'rev-parse', 'HEAD']),
                 'testedTree': run(['git', 'rev-parse', 'HEAD^{tree}']),
                 'status': run(['git', 'status', '--porcelain', '--untracked-files=all']),
                 'targetSha': src['targetSha'], 'targetTree': src['targetTree'],
                 'contextSha256': digest(out / 'context.tar')}
        write(out / 'after-source.json', after)
        assert after == {'checkoutSha': src['checkoutSha'], 'testedTree': src['testedTree'],
                         'status': '', 'targetSha': src['targetSha'], 'targetTree': src['targetTree'],
                         'contextSha256': src['contextSha256']}, 'Source changed'
    write(out / 'artifact-hashes.json', {
        str(p.relative_to(out)): {'sha256': digest(p), 'bytes': p.stat().st_size}
        for p in out.rglob('*') if p.is_file() and p.name != 'artifact-hashes.json'
    })


if __name__ == '__main__':
    commands = {'source': source, 'build': build, 'smoke': smoke,
                'archive': archive, 'cleanup': cleanup, 'manifest': manifest}
    assert len(sys.argv) == 2 and sys.argv[1] in commands
    commands[sys.argv[1]]()
