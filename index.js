const xml2js = require("xml2js");
const fs = require("fs");
const core = require("@actions/core");
const github = require("@actions/github");
const S3 = require("aws-sdk/clients/s3");
const path = require("path");

fs.readFileAsync = (filename) =>
  new Promise((resolve, reject) => {
    fs.readFile(filename, { encoding: "utf-8" }, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(`${data}`.replace("\ufeff", ""));
      }
    });
  });

fs.writeFileAsync = (filename, content) =>
  new Promise((resolve, reject) => {
    fs.writeFile(filename, content, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(`${data}`.replace("\ufeff", ""));
      }
    });
  });

const parser = new xml2js.Parser(/* options */);

async function readFile(filename) {
  return parser.parseStringPromise(await fs.readFileAsync(filename));
}

function calcRate({ total, covered }) {
  return total ? Number((covered / total) * 100).toFixed(2) * 1 : 0;
}

function readMetric(coverage) {
  const data = coverage.coverage.project[0].metrics[0].$;
  const metric = {
    statements: {
      total: data.elements * 1,
      covered: data.coveredelements * 1,
    },
    lines: {
      total: data.statements * 1,
      covered: data.coveredstatements * 1,
    },
    methods: {
      total: data.methods * 1,
      covered: data.coveredmethods * 1,
    },
    branches: {
      total: data.conditionals * 1,
      covered: data.coveredconditionals * 1,
    },
  };

  metric.statements.rate = calcRate(metric.statements);
  metric.lines.rate = calcRate(metric.lines);
  metric.methods.rate = calcRate(metric.methods);
  metric.branches.rate = calcRate(metric.branches);
  metric.averageRate =
    [
      metric.statements.rate,
      metric.lines.rate,
      metric.methods.rate,
      metric.branches.rate,
    ].reduce((a, b) => a + b) / 4;
  return metric;
}

function generateBadgeUrl(metric) {
  const color = metric.averageRate > 50 ? "green" : "red";
  return `https://img.shields.io/static/v1?label=coverage&message=${Math.round(
    metric.averageRate
  )}%&color=${color}`;
}

function generateEmoji(metric) {
  return metric.averageRate > 50 ? " 🎉" : "";
}

function generateInfo({ rate, total, covered }) {
  return `${rate}% ( ${covered} / ${total} )`;
}

function generateCommentHeader({ commentContext }) {
  return `<!-- coverage: ${commentContext} -->`;
}

function generateTable({ metric, commentContext }) {
  return `${generateCommentHeader({ commentContext })}
## ${commentContext}${generateEmoji(metric)}
|  Totals | ![Coverage](${generateBadgeUrl(metric)}) |
| :-- | --: |
| Statements: | ${generateInfo(metric.statements)} |
| Methods: | ${generateInfo(metric.methods)} |
| Lines: | ${generateInfo(metric.lines)} |
| Branches: | ${generateInfo(metric.branches)} |
`;
}

function generateStatus({ metric, targetUrl, statusContext, originalMetric }) {
  const {
    lines: { rate: lineRate },
    statements: { rate: statementsRate },
    methods: { rate: methodsRate },
    branches: { rate: branchesRate },
  } = metric;
  if (originalMetric) {
    const {
      lines: { rate: originalLineRate },
      statements: { rate: originalStatementsRate },
      methods: { rate: originalMethodsRate },
      branches: { rate: originalBranchesRate },
    } = originalMetric;
    core.info(JSON.stringify(originalMetric));
    core.info(JSON.stringify(metric));
    if (
      originalBranchesRate > branchesRate ||
      originalLineRate > lineRate ||
      originalMethodsRate > methodsRate ||
      originalStatementsRate > statementsRate
    ) {
      let description = "Failure: ";
      if (originalBranchesRate > branchesRate) {
        description += `Branches Coverage decrease - ${
          originalBranchesRate - branchesRate
        }%,`;
      }
      if (originalLineRate > lineRate) {
        description += `Line Coverage decrease - ${
          originalLineRate - lineRate
        }%,`;
      }
      if (originalMethodsRate > methodsRate) {
        description = `Methods Coverage decrease - ${
          originalMethodsRate - methodsRate
        }%,`;
      }
      if (originalStatementsRate > statementsRate) {
        description += `Statements Coverage decrease - ${
          originalStatementsRate - statementsRate
        }%,`;
      }
      return {
        state: "failure",
        description,
        target_url: targetUrl,
        context: statusContext,
      };
    }
  }
  return {
    state: "success",
    description: `Success: Line Coverage - ${lineRate}%, Statement Coverage - ${statementsRate}%, Methods Coverage - ${methodsRate}%,\Branchs Coverage - ${branchesRate}%`,
    target_url: targetUrl,
    context: statusContext,
  };
}

function toBool(value) {
  return typeof value === "boolean" ? value : value === "true";
}

function toInt(value) {
  return value * 1;
}

function loadConfig({ getInput }) {
  const comment = toBool(getInput("comment"));
  const check = toBool(getInput("check"));
  const githubToken = process.env.GITHUB_TOKEN;
  const cloverFile = getInput("clover_file", { required: true });
  const originalCloverFile = getInput("original_clover_file", {
    required: true,
  });
  const updateCoverage = getInput("update_coverage");
  const thresholdAlert = toInt(getInput("threshold_alert") || 90);
  const thresholdWarning = toInt(getInput("threshold_warning") || 50);
  const statusContext = getInput("status_context") || "Coverage Report";
  const commentContext = getInput("comment_context") || "Coverage Report";
  let commentMode = getInput("comment_mode");

  if (!["replace", "update", "insert"].includes(commentMode)) {
    commentMode = "replace";
  }

  return {
    comment,
    check,
    githubToken,
    cloverFile,
    thresholdAlert,
    thresholdWarning,
    statusContext,
    commentContext,
    commentMode,
    originalCloverFile,
    updateCoverage,
  };
}

function parseWebhook(request) {
  const {
    payload: {
      pull_request: {
        number: prNumber,
        html_url: prUrl,
        head: { sha } = {},
      } = {},
    } = {},
  } = request || {};

  if (!prNumber || !prUrl || !sha) {
    throw new Error("Action supports only pull_request event");
  }

  return {
    prNumber,
    prUrl,
    sha,
  };
}

async function createStatus({ client, context, sha, status }) {
  client.repos.createCommitStatus({
    ...context.repo,
    sha,
    ...status,
  });
}

async function listComments({ client, context, prNumber, commentHeader }) {
  core.info(client);
  core.info(client.issue);
  const { data: existingComments } = await client.issues.listComments({
    ...context.repo,
    issue_number: prNumber,
  });

  return existingComments.filter(({ body }) => body.startsWith(commentHeader));
}

async function insertComment({ client, context, prNumber, body }) {
  client.issues.createComment({
    ...context.repo,
    issue_number: prNumber,
    body,
  });
}

async function updateComment({ client, context, body, commentId }) {
  client.issues.updateComment({
    ...context.repo,
    comment_id: commentId,
    body,
  });
}

async function deleteComments({ client, context, comments }) {
  Promise.all(
    comments.map(({ id }) =>
      client.issues.deleteComment({
        ...context.repo,
        comment_id: id,
      })
    )
  );
}

async function upsertComment({
  client,
  context,
  prNumber,
  body,
  existingComments,
}) {
  const last = existingComments.pop();

  await deleteComments({
    client,
    context,
    comments: existingComments,
  });

  return last
    ? updateComment({
        client,
        context,
        body,
        commentId: last.id,
      })
    : insertComment({
        client,
        context,
        prNumber,
        body,
      });
}

async function replaceComment({
  client,
  context,
  prNumber,
  body,
  existingComments,
}) {
  await deleteComments({
    client,
    context,
    comments: existingComments,
  });

  return insertComment({
    client,
    context,
    prNumber,
    body,
  });
}

async function s3Upload(params) {
  return new Promise((resolve) => {
    s3.upload(params, (err, data) => {
      if (err) core.error(err);
      core.info(`uploaded - ${data.Key}`);
      core.info(`located - ${data.Location}`);
      resolve(data.Location);
    });
  });
}

async function s3Download(params) {
  const fileParams = { Bucket: "myBucket", Key: "myKey.csv" };
  return new Promise((resolve) => {
    s3.getObject(fileParams, function (err, data) {
      if (err) core.error(err);
      resolve(data.Body.toString());
    });
  });
}

const s3 = new S3({
  accessKeyId: process.env.S3_ACCESS_KEY,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  region: process.env.S3_REGION,
});

async function run() {
  try {
    const { context = {} } = github || {};
    const {
      githubToken,
      cloverFile,
      statusContext,
      originalCloverFile,
      commentContext,
      updateCoverage,
    } = loadConfig(core);
    if (core.isDebug()) {
      core.debug("Handle webhook request");
      console.log(context);
    }

    const client = github.getOctokit(githubToken);
    if (updateCoverage) {
      const S3_BUCKET = process.env.S3_BUCKET;

      const fileStream = fs.createReadStream(cloverFile);
      const bucketPath = path.join("tf-miniapp-coverage", originalCloverFile);
      const params = {
        Bucket: S3_BUCKET,
        ACL: "public-read",
        Body: fileStream,
        Key: bucketPath,
        ContentType: "text/xml",
      };
      await s3Upload(s3, params);
      return;
    }
    const { prNumber, prUrl, sha } = parseWebhook(context);
    const coverage = await readFile(cloverFile);
    const metric = readMetric(coverage);
    let originalMetric;
    try {
      const fileParams = { Bucket: S3_BUCKET, Key: originalCloverFile };
      const originCoverage = parser.parseString(await s3Download(fileParams));
      originalMetric = readMetric(originCoverage);
      core.info(`originalMetric: ${JSON.stringify(originalMetric)}`);
    } catch (e) {}

    const message = generateTable({ metric, commentContext });

    await replaceComment({
      client,
      context,
      prNumber,
      body: message,
      existingComments: await listComments({
        client,
        context,
        prNumber,
        commentContext,
        commentHeader: generateCommentHeader({ commentContext }),
      }),
    });

    const status = generateStatus({
      targetUrl: prUrl,
      metric,
      statusContext,
      originalMetric,
    });
    const { state, description } = status;
    if (status.state === "failure") {
      core.setFailed(status.description);
    } else {
      core.setOutput("coverage", description);
    }
  } catch (e) {
    core.setFailed(e.message);
  }
}

run().catch((e) => core.setFailed(e.message));
