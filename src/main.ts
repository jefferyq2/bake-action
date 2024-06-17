import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import * as actionsToolkit from '@docker/actions-toolkit';

import {Buildx} from '@docker/actions-toolkit/lib/buildx/buildx';
import {History as BuildxHistory} from '@docker/actions-toolkit/lib/buildx/history';
import {Context} from '@docker/actions-toolkit/lib/context';
import {Docker} from '@docker/actions-toolkit/lib/docker/docker';
import {Exec} from '@docker/actions-toolkit/lib/exec';
import {GitHub} from '@docker/actions-toolkit/lib/github';
import {Toolkit} from '@docker/actions-toolkit/lib/toolkit';
import {Util} from '@docker/actions-toolkit/lib/util';

import {BakeDefinition} from '@docker/actions-toolkit/lib/types/buildx/bake';
import {ConfigFile} from '@docker/actions-toolkit/lib/types/docker/docker';

import * as context from './context';
import * as stateHelper from './state-helper';

actionsToolkit.run(
  // main
  async () => {
    const startedTime = new Date();

    const inputs: context.Inputs = await context.getInputs();
    core.debug(`inputs: ${JSON.stringify(inputs)}`);
    stateHelper.setInputs(inputs);

    const toolkit = new Toolkit();
    const gitAuthToken = process.env.BUILDX_BAKE_GIT_AUTH_TOKEN ?? inputs['github-token'];

    await core.group(`GitHub Actions runtime token ACs`, async () => {
      try {
        await GitHub.printActionsRuntimeTokenACs();
      } catch (e) {
        core.warning(e.message);
      }
    });

    await core.group(`Docker info`, async () => {
      try {
        await Docker.printVersion();
        await Docker.printInfo();
      } catch (e) {
        core.info(e.message);
      }
    });

    await core.group(`Proxy configuration`, async () => {
      let dockerConfig: ConfigFile | undefined;
      let dockerConfigMalformed = false;
      try {
        dockerConfig = await Docker.configFile();
      } catch (e) {
        dockerConfigMalformed = true;
        core.warning(`Unable to parse config file ${path.join(Docker.configDir, 'config.json')}: ${e}`);
      }
      if (dockerConfig && dockerConfig.proxies) {
        for (const host in dockerConfig.proxies) {
          let prefix = '';
          if (Object.keys(dockerConfig.proxies).length > 1) {
            prefix = '  ';
            core.info(host);
          }
          for (const key in dockerConfig.proxies[host]) {
            core.info(`${prefix}${key}: ${dockerConfig.proxies[host][key]}`);
          }
        }
      } else if (!dockerConfigMalformed) {
        core.info('No proxy configuration found');
      }
    });

    if (!(await toolkit.buildx.isAvailable())) {
      core.setFailed(`Docker buildx is required. See https://github.com/docker/setup-buildx-action to set up buildx.`);
      return;
    }

    stateHelper.setTmpDir(Context.tmpDir());

    await core.group(`Buildx version`, async () => {
      await toolkit.buildx.printVersion();
    });

    await core.group(`Builder info`, async () => {
      const builder = await toolkit.builder.inspect(inputs.builder);
      core.info(JSON.stringify(builder, null, 2));
      stateHelper.setBuilder(builder);
    });

    let definition: BakeDefinition | undefined;
    await core.group(`Parsing raw definition`, async () => {
      definition = await toolkit.buildxBake.getDefinition(
        {
          files: inputs.files,
          load: inputs.load,
          noCache: inputs['no-cache'],
          overrides: inputs.set,
          provenance: inputs.provenance,
          push: inputs.push,
          sbom: inputs.sbom,
          source: inputs.source,
          targets: inputs.targets,
          githubToken: gitAuthToken
        },
        {
          cwd: inputs.workdir
        }
      );
    });
    if (!definition) {
      throw new Error('Bake definition not set');
    }
    stateHelper.setBakeDefinition(definition);

    const args: string[] = await context.getArgs(inputs, definition, toolkit);
    const buildCmd = await toolkit.buildx.getCommand(args);
    const buildEnv = Object.assign({}, process.env, {
      BUILDX_BAKE_GIT_AUTH_TOKEN: gitAuthToken
    }) as {
      [key: string]: string;
    };

    await core.group(`Bake definition`, async () => {
      await Exec.exec(buildCmd.command, [...buildCmd.args, '--print'], {
        cwd: inputs.workdir,
        env: buildEnv
      });
    });

    let err: Error | undefined;
    await Exec.getExecOutput(buildCmd.command, buildCmd.args, {
      cwd: inputs.workdir,
      env: buildEnv,
      ignoreReturnCode: true
    }).then(res => {
      if (res.stderr.length > 0 && res.exitCode != 0) {
        err = Error(`buildx bake failed with: ${res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? 'unknown error'}`);
      }
    });

    const metadata = toolkit.buildxBake.resolveMetadata();
    if (metadata) {
      await core.group(`Metadata`, async () => {
        const metadatadt = JSON.stringify(metadata, null, 2);
        core.info(metadatadt);
        core.setOutput('metadata', metadatadt);
      });
    }
    await core.group(`Build references`, async () => {
      const refs = await buildRefs(toolkit, startedTime, inputs.builder);
      if (refs) {
        for (const ref of refs) {
          core.info(ref);
        }
        stateHelper.setBuildRefs(refs);
      } else {
        core.warning('No build refs found');
      }
    });
    if (err) {
      throw err;
    }
  },
  // post
  async () => {
    if (stateHelper.buildRefs.length > 0) {
      await core.group(`Generating build summary`, async () => {
        if (process.env.DOCKER_BUILD_NO_SUMMARY && Util.parseBool(process.env.DOCKER_BUILD_NO_SUMMARY)) {
          core.info('Summary disabled');
          return;
        }
        if (stateHelper.builder && stateHelper.builder.driver === 'cloud') {
          core.info('Summary is not yet supported with Docker Build Cloud');
          return;
        }
        try {
          const buildxHistory = new BuildxHistory();
          const exportRes = await buildxHistory.export({
            refs: stateHelper.buildRefs
          });
          core.info(`Build records exported to ${exportRes.dockerbuildFilename} (${Util.formatFileSize(exportRes.dockerbuildSize)})`);
          const uploadRes = await GitHub.uploadArtifact({
            filename: exportRes.dockerbuildFilename,
            mimeType: 'application/gzip',
            retentionDays: 90
          });
          await GitHub.writeBuildSummary({
            exportRes: exportRes,
            uploadRes: uploadRes,
            inputs: stateHelper.inputs,
            bakeDefinition: stateHelper.bakeDefinition
          });
        } catch (e) {
          core.warning(e.message);
        }
      });
    }
    if (stateHelper.tmpDir.length > 0) {
      await core.group(`Removing temp folder ${stateHelper.tmpDir}`, async () => {
        fs.rmSync(stateHelper.tmpDir, {recursive: true});
      });
    }
  }
);

async function buildRefs(toolkit: Toolkit, since: Date, builder?: string): Promise<Array<string>> {
  // get refs from metadata file
  const metaRefs = toolkit.buildxBake.resolveRefs();
  if (metaRefs) {
    return metaRefs;
  }
  // otherwise, look for the very first build ref since the build has started
  if (!builder) {
    const currentBuilder = await toolkit.builder.inspect();
    builder = currentBuilder.name;
  }
  const res = Buildx.refs({
    dir: Buildx.refsDir,
    builderName: builder,
    since: since
  });
  const refs: Array<string> = [];
  for (const ref in res) {
    if (Object.prototype.hasOwnProperty.call(res, ref)) {
      refs.push(ref);
    }
  }
  return refs;
}
