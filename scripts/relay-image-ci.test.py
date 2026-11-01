import copy
from contextlib import ExitStack
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tarfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('relay_image_ci', Path(__file__).with_name('relay-image-ci.py'))
ci = importlib.util.module_from_spec(spec)
with patch.object(subprocess, 'check_output', side_effect=AssertionError('No engine calls on import')), \
     patch.object(subprocess, 'run', side_effect=AssertionError('No engine calls on import')):
    spec.loader.exec_module(ci)

# Verbatim metadata from hosted41156315131/artifact13025470465, not an inspection fixture.
ACTUAL_CLASSIC_METADATA_RAW = r'''{
  "buildx.build.provenance": {
    "builder": {
      "id": ""
    },
    "buildType": "https://mobyproject.org/buildkit@v1",
    "materials": [
      {
        "uri": "pkg:docker/oven/bun@1.4.1-slim?digest=sha256:887d0f37f674c69984be4e397fef29ca0d74df1e75155431abbe857258bffde5\u0026platform=linux%2Famd64",
        "digest": {
          "sha256": "887d0f37f674c69984be4e397fef29ca0d74df1e75155431abbe857258bffde5"
        }
      },
      {
        "uri": "http://buildkit-session/li52359ljf0dif560x2zu131t",
        "digest": {
          "sha256": "6d35d75fd8fcc2671b37152304b5345b12b68f23b3f6fd32ac749179383ff5ad"
        }
      }
    ],
    "invocation": {
      "configSource": {
        "uri": "http://buildkit-session/li52359ljf0dif560x2zu131t",
        "digest": {
          "sha256": "6d35d75fd8fcc2671b37152304b5345b12b68f23b3f6fd32ac749179383ff5ad"
        },
        "entryPoint": "packages/server/relay.Dockerfile"
      },
      "parameters": {
        "frontend": "dockerfile.v0",
        "args": {
          "label:org.opencontainers.image.revision": "d50283c01b8b4e09fb80239cde98df96575defaf",
          "no-cache": ""
        }
      },
      "environment": {
        "platform": "linux/amd64"
      }
    }
  },
  "buildx.build.ref": "default/default/dehf5vaq3upavp2bs28s4jdc9",
  "containerimage.config.digest": "sha256:6fe2a565c6cc51d7b19a6cef0e1e60a198e748643cbaaf8350f7c60688776943",
  "containerimage.digest": "sha256:6fe2a565c6cc51d7b19a6cef0e1e60a198e748643cbaaf8350f7c60688776943",
  "image.name": "docker.io/library/clave-relay-ci:relay-image-41156315131-1"
}'''
ACTUAL_CLASSIC_METADATA = json.loads(ACTUAL_CLASSIC_METADATA_RAW)


class ImagePredicates(unittest.TestCase):
    def setUp(self):
        output_guard = patch.object(ci.subprocess, 'check_output',
                                    side_effect=AssertionError('No engine calls in unit tests'))
        process_guard = patch.object(ci.subprocess, 'run',
                                     side_effect=AssertionError('No engine calls in unit tests'))
        output_guard.start()
        self.direct_process = process_guard.start()
        self.addCleanup(output_guard.stop)
        self.addCleanup(process_guard.stop)
        self.iid = 'sha256:' + 'a' * 64
        self.sha = 'b' * 40
        self.source = {'targetSha': self.sha, 'targetTree': 'c' * 40,
                       'contextSha256': 'd' * 64, 'checkoutSha': 'e' * 40}
        self.image = {'Id': self.iid, 'Os': 'linux', 'Architecture': 'amd64',
                      'Config': {'Labels': ci.image_labels(self.source)}}
        self.metadata = {'containerimage.config.digest': self.iid,
                         'containerimage.digest': 'sha256:' + 'c' * 64,
                         'containerimage.descriptor': {'digest': 'sha256:' + 'c' * 64,
                          'mediaType': 'application/vnd.oci.image.manifest.v1+json'}}

    def test_exact_identity_and_platform(self):
        result = ci.validate_image(self.iid, self.image, self.metadata, self.source)
        self.assertEqual(result['kind'], 'manifest')
        self.assertEqual(result['manifestDigest'], self.metadata['containerimage.digest'])

    def test_actual_classic_metadata_is_explicitly_config_only(self):
        self.assertEqual(hashlib.sha256(ACTUAL_CLASSIC_METADATA_RAW.encode()).hexdigest(),
                         '77f148019979b418f037a420a5f91d178b320b526a197d32defefabf690d075f')
        metadata = copy.deepcopy(ACTUAL_CLASSIC_METADATA)
        iid = metadata['containerimage.config.digest']
        # Explicitly synthetic inspection; the first failed run did not retain its real one.
        image = copy.deepcopy(self.image)
        image['Id'] = iid
        result = ci.validate_image(iid, image, metadata, self.source)
        self.assertEqual(result['kind'], 'image-config')
        self.assertEqual(result['imageId'], iid)
        self.assertIsNone(result['manifestDigest'])
        self.assertIsNone(result['manifestMediaType'])

    def test_descriptor_absent_but_exporter_mismatched_is_not_config_only(self):
        metadata = copy.deepcopy(ACTUAL_CLASSIC_METADATA)
        iid = metadata['containerimage.config.digest']
        image = copy.deepcopy(self.image)
        image['Id'] = iid
        metadata['containerimage.digest'] = 'sha256:' + 'd' * 64
        with self.assertRaises(AssertionError):
            ci.validate_image(iid, image, metadata, self.source)

    def test_present_descriptor_never_falls_back_to_config_only(self):
        iid = ACTUAL_CLASSIC_METADATA['containerimage.config.digest']
        image = copy.deepcopy(self.image)
        image['Id'] = iid
        for descriptor in [None, {}, {'digest': iid, 'mediaType': 'unknown'},
                           {'digest': 'sha256:' + 'd' * 64,
                            'mediaType': 'application/vnd.oci.image.manifest.v1+json'},
                           {'digest': iid, 'mediaType': 'application/vnd.oci.image.manifest.v1+json'}]:
            with self.subTest(descriptor=descriptor):
                metadata = copy.deepcopy(ACTUAL_CLASSIC_METADATA)
                metadata['containerimage.descriptor'] = descriptor
                with self.assertRaises(AssertionError):
                    ci.validate_image(iid, image, metadata, self.source)

    def test_failed_validator_retains_raw_inspection(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'
        }):
            out = Path(directory)
            (out / 'context.tar').write_bytes(b'synthetic source archive')
            (out / 'source.json').write_text(json.dumps({
                'checkoutSha': self.sha, 'contextSha256': ci.digest(out / 'context.tar')
            }))
            def fake_build(*args, **kwargs):
                (out / 'image-id').write_text(self.iid)
                (out / 'build-metadata.json').write_text(json.dumps(self.metadata))
                return subprocess.CompletedProcess(args, 0)
            with patch.object(ci, 'evidence', return_value=out), patch.object(
                ci, 'run', side_effect=['mock docker', 'mock buildx', json.dumps([self.image])]
            ), patch.object(ci.subprocess, 'run', side_effect=fake_build), patch.object(
                ci, 'validate_image', side_effect=AssertionError('Deliberate validation rejection')
            ), patch.object(ci, 'bound_source', return_value=self.source):
                with self.assertRaises(AssertionError):
                    ci.build()
            self.assertTrue((out / 'image-inspect.json').exists())
            self.assertEqual(json.loads((out / 'image-inspect.json').read_text()), [self.image])

    def test_each_image_binding_is_required(self):
        for label in ['org.opencontainers.image.revision', 'com.clave.target.tree',
                      'com.clave.target.context-sha256', 'com.clave.controller.revision']:
            for replacement in [None, 'f' * 40]:
                with self.subTest(label=label, replacement=replacement):
                    image = copy.deepcopy(self.image)
                    if replacement is None:
                        del image['Config']['Labels'][label]
                    else:
                        image['Config']['Labels'][label] = replacement
                    with self.assertRaises(AssertionError):
                        ci.validate_image(self.iid, image, self.metadata, self.source)

    def test_build_uses_bound_tar_and_both_identities(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'
        }):
            out = Path(directory)
            (out / 'context.tar').write_bytes(b'own synthetic target tar')
            def fake_build(argv, **kwargs):
                self.assertEqual(argv[:3], ['docker', 'buildx', 'build'])
                self.assertEqual(argv[-1], '-')
                self.assertEqual(kwargs['stdin'].read(), b'own synthetic target tar')
                for label, value in ci.image_labels(self.source).items():
                    self.assertIn(label + '=' + value, argv)
                self.assertIn('org.opencontainers.image.revision=' + self.sha, argv)
                self.assertNotIn('org.opencontainers.image.revision=' + self.source['checkoutSha'], argv)
                (out / 'image-id').write_text(self.iid)
                (out / 'build-metadata.json').write_text(json.dumps(self.metadata))
                return subprocess.CompletedProcess(argv, 0)
            with patch.object(ci, 'evidence', return_value=out), patch.object(
                ci, 'bound_source', return_value=self.source
            ), patch.object(ci, 'run', side_effect=['mock docker', 'mock buildx', json.dumps([self.image])]), \
                 patch.object(ci.subprocess, 'run', side_effect=fake_build):
                ci.build()
            identity = json.loads((out / 'image-identity.json').read_text())
            self.assertEqual(identity['sourceBindings'], ci.image_labels(self.source))
            ci.validate_stored_image(out, self.source, self.iid)
            changed = copy.deepcopy(self.source)
            changed['targetTree'] = 'f' * 40
            with self.assertRaises(AssertionError):
                ci.validate_stored_image(out, changed, self.iid)

    def test_unbound_receipt_stops_all_engine_entrypoints(self):
        for operation in [ci.build, ci.smoke, ci.archive]:
            with self.subTest(operation=operation.__name__), patch.object(
                ci, 'bound_source', side_effect=AssertionError('Deliberate unbound source')
            ), patch.object(ci, 'evidence', return_value=Path('/unused-synthetic')), \
                 patch.object(ci, 'run') as commands:
                with self.assertRaises(AssertionError):
                    operation()
                commands.assert_not_called()
                self.direct_process.assert_not_called()

    def test_actual_checkout_and_ordered_parents_are_required(self):
        merge, tree, head, base = (x * 40 for x in ['a', 'b', 'c', 'd'])
        ci.validate_source(merge, tree, [base, head], merge, head, base)
        for parents, event in [([head, base], merge), ([base, head], head)]:
            with self.assertRaises(AssertionError):
                ci.validate_source(merge, tree, parents, event, head, base)

    def test_wrong_platform_cannot_pass(self):
        self.image['Architecture'] = 'arm64'
        with self.assertRaises(AssertionError):
            ci.validate_image(self.iid, self.image, self.metadata, self.source)

    def test_head_label_is_not_a_substitute_for_actual_tested_merge(self):
        self.image['Config']['Labels']['org.opencontainers.image.revision'] = 'd' * 40
        with self.assertRaises(AssertionError):
            ci.validate_image(self.iid, self.image, self.metadata, self.source)

    def test_digest_mismatch_cannot_pass(self):
        for key in ['containerimage.config.digest', 'containerimage.digest']:
            changed = copy.deepcopy(self.metadata)
            changed[key] = 'sha256:' + 'd' * 64
            with self.assertRaises(AssertionError):
                ci.validate_image(self.iid, self.image, changed, self.source)

    def test_healthy_and_unauthorized(self):
        ci.validate_smoke({'status': 'live', 'machines': 0, 'online': 0}, 401)

    def test_successful_unauthenticated_listing_fails_gate(self):
        with self.assertRaises(AssertionError):
            ci.validate_smoke({'status': 'live', 'machines': 0, 'online': 0}, 200)

    def test_unhealthy_body_fails_gate(self):
        with self.assertRaises(AssertionError):
            ci.validate_smoke({'status': 'live', 'machines': 1, 'online': 0}, 401)

    def test_embedded_provenance_must_match_not_just_exist(self):
        expected = {'workspaceLockSha256': 'a' * 64,
                    'packages': [{'version': '3.22.1', 'integrity': 'locked'}]}
        ci.validate_dependencies(copy.deepcopy(expected), expected)
        changed = copy.deepcopy(expected)
        changed['packages'][0]['version'] = '3.22.0'
        with self.assertRaises(AssertionError):
            ci.validate_dependencies(changed, expected)

    def test_cleanup_ownership_checks_id_name_and_label(self):
        cid = 'a' * 64
        value = {'Id': cid, 'Name': '/owned', 'Config': {'Labels': {ci.OWNER_LABEL: 'owned'}}}
        self.assertEqual(ci.validate_owned_container(value, 'owned', cid), cid)
        for key in ['id', 'name', 'label']:
            changed = copy.deepcopy(value)
            if key == 'id': changed['Id'] = 'b' * 64
            if key == 'name': changed['Name'] = '/foreign'
            if key == 'label': changed['Config']['Labels'][ci.OWNER_LABEL] = 'foreign'
            with self.assertRaises(AssertionError):
                ci.validate_owned_container(changed, 'owned', cid)

    def test_cleanup_never_removes_a_foreign_label(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'
        }):
            out = Path(directory)
            (out / 'create-attempted').write_text('attempted')
            (out / 'container-id').write_text('a' * 64)
            foreign = {'Id': 'a' * 64, 'Name': '/' + ci.owner(),
                       'Config': {'Labels': {ci.OWNER_LABEL: 'foreign'}}}
            with patch.object(ci, 'evidence', return_value=out), patch.object(
                ci, 'run', return_value=json.dumps([foreign])
            ) as commands:
                with self.assertRaises(AssertionError):
                    ci.cleanup()
                self.assertEqual(commands.call_count, 1)
                self.assertNotIn('rm', commands.call_args.args[0])
                self.direct_process.assert_not_called()
            self.assertFalse(json.loads((out / 'cleanup.json').read_text())['removed'])

    def test_cleanup_removes_only_validated_id_and_records_absence(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'
        }):
            out = Path(directory)
            cid = 'a' * 64
            (out / 'create-attempted').write_text('attempted')
            (out / 'container-id').write_text(cid)
            owned = {'Id': cid, 'Name': '/' + ci.owner(),
                     'Config': {'Labels': {ci.OWNER_LABEL: ci.owner()}}}
            def response(argv, **kwargs):
                if 'logs' in argv:
                    return subprocess.CompletedProcess(argv, 0)
                return subprocess.CompletedProcess(argv, 1, '[]', 'Error: No such container: ' + cid)
            with patch.object(ci, 'evidence', return_value=out), patch.object(
                ci, 'run', side_effect=[json.dumps([owned]), cid]
            ) as commands, patch.object(ci.subprocess, 'run', side_effect=response):
                ci.cleanup()
                self.assertEqual(commands.call_args_list[-1].args[0],
                                 ['docker', 'container', 'rm', '--force', '--volumes', cid])
            self.assertEqual(json.loads((out / 'cleanup.json').read_text())['containerId'], cid)

    def cleanup_case(self, log_failure=None, absence=None):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'
        }), ExitStack() as stack:
            out = Path(directory)
            cid = 'a' * 64
            (out / 'create-attempted').write_text('attempted')
            (out / 'container-id').write_text(cid)
            owned = {'Id': cid, 'Name': '/' + ci.owner(),
                     'Config': {'Labels': {ci.OWNER_LABEL: ci.owner()}}}
            original_open = Path.open
            def open_file(path, *args, **kwargs):
                if log_failure == 'file' and path.name == 'container.log':
                    raise OSError('Diagnostic file unavailable')
                return original_open(path, *args, **kwargs)
            def response(argv, **kwargs):
                if 'logs' in argv:
                    if log_failure == 'spawn':
                        raise OSError('Diagnostic subprocess unavailable')
                    return subprocess.CompletedProcess(argv, 0)
                return subprocess.CompletedProcess(argv, 1, '[]',
                    absence or 'Error: No such container: ' + cid)
            stack.enter_context(patch.object(Path, 'open', new=open_file))
            stack.enter_context(patch.object(ci, 'evidence', return_value=out))
            commands = stack.enter_context(patch.object(ci, 'run', side_effect=[json.dumps([owned]), cid]))
            stack.enter_context(patch.object(ci.subprocess, 'run', side_effect=response))
            try:
                ci.cleanup()
            except (OSError, AssertionError):
                pass
            return json.loads((out / 'cleanup.json').read_text()), [c.args[0] for c in commands.call_args_list]

    def test_diagnostic_errors_do_not_skip_validated_owned_removal(self):
        for failure in ['file', 'spawn']:
            with self.subTest(failure=failure):
                result, commands = self.cleanup_case(log_failure=failure)
                self.assertIn(['docker', 'container', 'rm', '--force', '--volumes', 'a' * 64], commands)
                self.assertTrue(result['removed'])
                self.assertIn('logsError', result)

    def test_unrelated_or_unavailable_daemon_is_not_positive_absence(self):
        for message in ['Error response from daemon: No such volume: unrelated-volume',
                        'Error: No such container: ' + 'b' * 64,
                        'Cannot connect to daemon: No such file or directory']:
            with self.subTest(message=message):
                result, _ = self.cleanup_case(absence=message)
                self.assertFalse(result['removed'])
                self.assertEqual(result['status'], 'UNKNOWN; NO FOREIGN CLEANUP')


class TargetBindings(unittest.TestCase):
    """Own synthetic local Git fixtures. No hosted evidence or Docker execution."""

    def test_target_requires_both_exact_commit_and_tree(self):
        sha, tree = 'a' * 40, 'b' * 40
        ci.validate_target(sha, tree, sha, tree)
        for actual_sha, actual_tree, expected_sha, expected_tree in [
            ('c' * 40, tree, sha, tree), (sha, 'c' * 40, sha, tree),
            (sha, tree, '', tree), (sha, tree, sha, ''),
            (sha, tree, 'main', tree), (sha, tree, sha, 'b' * 39)
        ]:
            with self.subTest(binding=(actual_sha, actual_tree, expected_sha, expected_tree)):
                with self.assertRaises(AssertionError):
                    ci.validate_target(actual_sha, actual_tree, expected_sha, expected_tree)

    def test_missing_or_symbolic_pins_fail_before_git(self):
        for env in [{}, {'RELAY_TARGET_SHA': 'main', 'RELAY_TARGET_TREE': 'b' * 40},
                    {'RELAY_TARGET_SHA': 'a' * 40}]:
            with self.subTest(env=env), patch.dict(os.environ, env, clear=True), \
                 patch.object(ci, 'run') as commands:
                with self.assertRaises(AssertionError):
                    ci.target()
                commands.assert_not_called()

    def test_committed_workflow_pins_exact_allocated_target(self):
        workflow = Path(__file__).resolve().parents[1] / '.github/workflows/relay-image.yml'
        text = workflow.read_text()
        self.assertIn('RELAY_TARGET_SHA: 531bc17740af3004c6708fe94bca6b26f00ec753', text)
        self.assertIn('RELAY_TARGET_TREE: 72833cc0011bf96e6e7c250f1b67fa346f15f0da', text)
        self.assertIn('git fetch --no-tags --depth=1 origin "$RELAY_TARGET_SHA"', text)

    def test_source_archives_target_not_controller_and_rejects_tampering(self):
        self.source_fixture()

    def test_reviewer_rebased_controller_receipt_must_reject(self):
        def check(git, out, src):
            for key, value in [('eventSha', 'f' * 40), ('prHead', 'f' * 40),
                               ('prBase', 'f' * 40), ('parents', []), ('prNumber', 999)]:
                forged = copy.deepcopy(src)
                forged[key] = value
                ci.write(out / 'source.json', forged)
                with self.subTest(field=key), self.assertRaises(AssertionError):
                    ci.bound_source()
            ci.write(out / 'source.json', src)
            replacement = git('commit-tree', 'HEAD^{tree}', '-m', 'unrelated non-event controller')
            git('checkout', '--quiet', '--detach', replacement)
            forged = copy.deepcopy(src)
            forged.update(checkoutSha=replacement, testedTree=git('rev-parse', 'HEAD^{tree}'),
                          parents=[], eventSha=replacement, prHead=replacement, prBase=replacement)
            ci.write(out / 'source.json', forged)
            with self.assertRaises(AssertionError, msg='must independently recheck event and ordered parents'):
                ci.bound_source()
            # Even a receipt retaining the real event fields cannot bless this new HEAD.
            forged = copy.deepcopy(src)
            forged.update(checkoutSha=replacement, testedTree=git('rev-parse', 'HEAD^{tree}'), parents=[])
            ci.write(out / 'source.json', forged)
            with self.assertRaises(AssertionError):
                ci.bound_source()
        self.source_fixture(check)

    def test_reviewer_rebased_projection_receipt_must_reject(self):
        def check(git, out, src):
            # Mutable staging is not an authority. Fresh canonical inputs must still pass.
            for path in (out / 'target-inputs').iterdir():
                path.write_bytes(b'invalid mutable staging')
            ci.bound_source()
            projection = out / 'expected-dependencies/relay-dependencies.json'
            projection.write_text('{}')
            forged = copy.deepcopy(src)
            forged['expectedDependenciesSha256'] = ci.digest(projection)
            ci.write(out / 'source.json', forged)
            with self.assertRaises(AssertionError, msg='must independently rederive target projection'):
                ci.bound_source()
        self.source_fixture(check)

    def source_fixture(self, check=None):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            repo, out = Path(directory) / 'repo', Path(directory) / 'evidence'
            repo.mkdir()
            def git(*args):
                return subprocess.check_output(['git', '-C', str(repo),
                    '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
                    *args], text=True, timeout=20).strip()
            git('init', '--quiet')
            for name in ['package-lock.json', 'packages/server/relay.package.json',
                         'packages/server/relay-dependencies.mjs',
                         'packages/server/relay.Dockerfile', '.dockerignore']:
                dest = repo / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes((root / name).read_bytes())
            git('add', '.')
            git('commit', '--quiet', '-m', 'synthetic target')
            target, tree = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')
            # Distinct valid controller inputs expose a silent wrong-target archive.
            (repo / 'package-lock.json').write_bytes(b'\n' + (root / 'package-lock.json').read_bytes())
            (repo / 'packages/server/relay.Dockerfile').write_text('controller recipe, not target')
            git('add', '.')
            git('commit', '--quiet', '-m', 'synthetic controller inputs')
            head = git('rev-parse', 'HEAD')
            controller = git('commit-tree', 'HEAD^{tree}', '-p', target, '-p', head,
                             '-m', 'synthetic PR merge controller')
            git('checkout', '--quiet', '--detach', controller)
            event = Path(directory) / 'event.json'
            event.write_text(json.dumps({'pull_request': {
                'head': {'sha': head}, 'base': {'sha': target}, 'number': 1}}))
            env = {'RELAY_EVIDENCE': str(out), 'RELAY_PLATFORM': 'linux/amd64',
                   'RELAY_TARGET_SHA': target, 'RELAY_TARGET_TREE': tree,
                   'GITHUB_EVENT_PATH': str(event), 'GITHUB_SHA': controller,
                   'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'}
            previous = Path.cwd()
            real_run = ci.run
            def local_only(argv, timeout=20):
                self.assertIn(argv[0], ['git', 'node'], 'No engines/network in source fixture')
                return real_run(argv, timeout)
            try:
                os.chdir(repo)
                with patch.dict(os.environ, env), patch.object(ci, 'run', side_effect=local_only):
                    ci.source()
                    with tarfile.open(out / 'context.tar') as archive:
                        self.assertEqual(archive.extractfile('package-lock.json').read(),
                                         (root / 'package-lock.json').read_bytes(),
                                         'Build archive must use target lock, not controller lock')
                    src = ci.bound_source()
                    self.assertEqual(src['checkoutSha'], controller)
                    self.assertEqual(src['targetSha'], target)
                    self.assertEqual(src['targetTree'], tree)
                    with tarfile.open(out / 'context.tar') as archive:
                        self.assertEqual(archive.extractfile('package-lock.json').read(),
                                         (root / 'package-lock.json').read_bytes())
                    expected = json.loads((out / 'expected-dependencies/relay-dependencies.json').read_text())
                    self.assertEqual(expected['workspaceLockSha256'], src['rootLockSha256'])
                    self.assertEqual(expected['manifestSha256'],
                                     src['targetInputs']['packages/server/relay.package.json']['sha256'])
                    if check:
                        check(git, out, src)
                        return
                    # Wrong target tree must fail even with an otherwise valid controller.
                    with patch.dict(os.environ, {'RELAY_TARGET_TREE': 'f' * 40}):
                        with self.assertRaises(AssertionError):
                            ci.bound_source()
                    # Replacing the archive AND its recorded hash must still fail closed.
                    original = (out / 'context.tar').read_bytes()
                    git('archive', '--format=tar', '--output=' + str(out / 'context.tar'), controller)
                    forged = copy.deepcopy(src)
                    forged['contextSha256'] = ci.digest(out / 'context.tar')
                    ci.write(out / 'source.json', forged)
                    with self.assertRaises(AssertionError):
                        ci.bound_source()
                    (out / 'context.tar').write_bytes(original)
                    ci.write(out / 'source.json', src)
                    # Equal input blobs/tree are insufficient: the archive must bind the commit too.
                    equal_tree_commit = git('commit-tree', tree, '-m', 'synthetic equal-tree forgery')
                    git('archive', '--format=tar', '--output=' + str(out / 'context.tar'), equal_tree_commit)
                    forged = copy.deepcopy(src)
                    forged['contextSha256'] = ci.digest(out / 'context.tar')
                    ci.write(out / 'source.json', forged)
                    with self.assertRaises(AssertionError):
                        ci.bound_source()
                    (out / 'context.tar').write_bytes(original)
                    ci.write(out / 'source.json', src)
                    # A source receipt cannot rebind target to controller, even with its tree.
                    forged = copy.deepcopy(src)
                    forged.update(targetSha=controller, targetTree=git('rev-parse', 'HEAD^{tree}'))
                    ci.write(out / 'source.json', forged)
                    with self.assertRaises(AssertionError):
                        ci.bound_source()
                    ci.write(out / 'source.json', src)
                    projection = out / 'expected-dependencies/relay-dependencies.json'
                    projection.write_text('{}')
                    with self.assertRaises(AssertionError):
                        ci.bound_source()
            finally:
                os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
