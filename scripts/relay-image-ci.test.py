import copy
from contextlib import ExitStack
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
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
        self.image = {'Id': self.iid, 'Os': 'linux', 'Architecture': 'amd64',
                      'Config': {'Labels': {'org.opencontainers.image.revision': self.sha}}}
        self.metadata = {'containerimage.config.digest': self.iid,
                         'containerimage.digest': 'sha256:' + 'c' * 64,
                         'containerimage.descriptor': {'digest': 'sha256:' + 'c' * 64,
                          'mediaType': 'application/vnd.oci.image.manifest.v1+json'}}

    def test_exact_identity_and_platform(self):
        result = ci.validate_image(self.iid, self.image, self.metadata, self.sha)
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
        result = ci.validate_image(iid, image, metadata, self.sha)
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
            ci.validate_image(iid, image, metadata, self.sha)

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
                    ci.validate_image(iid, image, metadata, self.sha)

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
            ):
                with self.assertRaises(AssertionError):
                    ci.build()
            self.assertTrue((out / 'image-inspect.json').exists())
            self.assertEqual(json.loads((out / 'image-inspect.json').read_text()), [self.image])

    def test_actual_checkout_and_ordered_parents_are_required(self):
        merge, tree, head, base = (x * 40 for x in ['a', 'b', 'c', 'd'])
        ci.validate_source(merge, tree, [base, head], merge, head, base)
        for parents, event in [([head, base], merge), ([base, head], head)]:
            with self.assertRaises(AssertionError):
                ci.validate_source(merge, tree, parents, event, head, base)

    def test_wrong_platform_cannot_pass(self):
        self.image['Architecture'] = 'arm64'
        with self.assertRaises(AssertionError):
            ci.validate_image(self.iid, self.image, self.metadata, self.sha)

    def test_head_label_is_not_a_substitute_for_actual_tested_merge(self):
        self.image['Config']['Labels']['org.opencontainers.image.revision'] = 'd' * 40
        with self.assertRaises(AssertionError):
            ci.validate_image(self.iid, self.image, self.metadata, self.sha)

    def test_digest_mismatch_cannot_pass(self):
        for key in ['containerimage.config.digest', 'containerimage.digest']:
            changed = copy.deepcopy(self.metadata)
            changed[key] = 'sha256:' + 'd' * 64
            with self.assertRaises(AssertionError):
                ci.validate_image(self.iid, self.image, changed, self.sha)

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


if __name__ == '__main__':
    unittest.main()
