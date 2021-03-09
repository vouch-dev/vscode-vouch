// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as os from "os";
import * as path from "path";
import { Uri, workspace } from "vscode";
import { CONTENT_URI, FS_SCHEME } from "./constants";
import { api } from "./git";
import { StoreCodeReviewComment, Review, store } from "./store";

const HEADING_PATTERN = /^#+\s*(.*)/;
export function getStepLabel(
  tour: Review,
  stepNumber: number,
  includeStepNumber: boolean = true,
  defaultToFileName: boolean = true
) {
  const step = tour.comments[stepNumber];

  const prefix = includeStepNumber ? `#${stepNumber + 1} - ` : "";
  let label = "";
  if (step.title) {
    label = step.title;
  } else if (HEADING_PATTERN.test(step.description.trim())) {
    label = step.description.trim().match(HEADING_PATTERN)![1];
  } else if (step.markerTitle) {
    label = step.markerTitle;
  } else if (defaultToFileName) {
    label = step.uri
      ? step.uri!
      : decodeURIComponent(step.directory || step.file!);
  }

  let summary = "";
  if (step.selection) {
    summary = step.summary.toLocaleUpperCase();
  } else {
    summary = "COMPLETE";
  }

  return `${prefix}${summary}: ${label}`;
}

export function getTourTitle(tour: Review) {
  if (tour.title.match(/^#?\d+\s-/)) {
    return tour.title.split("-")[1].trim();
  }

  return tour.title;
}

export function getRelativePath(root: string, filePath: string) {
  let relativePath = path.relative(root, filePath);

  if (os.platform() === "win32") {
    relativePath = relativePath.replace(/\\/g, "/");
  }

  return relativePath;
}

export function appendUriPath(uri: Uri, pathSuffix: string) {
  const pathPrefix = uri.path.endsWith("/") ? uri.path : `${uri.path}/`;
  let filePath = `${pathPrefix}${pathSuffix}`;

  return uri.with({
    path: filePath
  });
}

export async function readUriContents(uri: Uri) {
  const bytes = await workspace.fs.readFile(uri);
  return new TextDecoder().decode(bytes);
}

export function getFileUri(file: string, workspaceRoot?: Uri) {
  if (!workspaceRoot) {
    return Uri.parse(file);
  }

  return appendUriPath(workspaceRoot, file);
}

export async function getStepFileUri(
  step: StoreCodeReviewComment,
  workspaceRoot?: Uri,
  ref?: string
): Promise<Uri> {
  let uri;
  if (step.contents) {
    uri = Uri.parse(`${FS_SCHEME}://current/${step.file}`);
  } else if (step.uri || step.file) {
    uri = step.uri
      ? Uri.parse(step.uri)
      : getFileUri(step.file!, workspaceRoot);

    if (api && ref && ref !== "HEAD") {
      const repo = api.getRepository(uri);

      if (
        repo &&
        repo.state.HEAD &&
        repo.state.HEAD.name !== ref && // The tour refs the user's current branch
        repo.state.HEAD.commit !== ref && // The tour refs the user's HEAD commit
        repo.state.HEAD.commit !== // The tour refs a branch/tag that points at the user's HEAD commit
        repo.state.refs.find(gitRef => gitRef.name === ref)?.commit
      ) {
        uri = await api.toGitUri(uri, ref);
      }
    }
  } else {
    uri = CONTENT_URI;
  }

  return uri;
}

export function getActiveWorkspacePath() {
  return store.activeTour!.workspaceRoot?.path || "";
}

export function getWorkspaceKey() {
  return workspace.workspaceFile || workspace.workspaceFolders![0].uri;
}

export function getWorkspacePath(tour: Review) {
  return getWorkspaceUri(tour)?.toString() || "";
}

export function getWorkspaceUri(tour: Review): Uri | undefined {
  const tourUri = Uri.parse(tour.id);
  return (
    workspace.getWorkspaceFolder(tourUri)?.uri ||
    (workspace.workspaceFolders && workspace.workspaceFolders[0].uri)
  );
}

function getTourNumber(tour: Review): number | undefined {
  const match = tour.title.match(/^#?(\d+)\s+-/);
  if (match) {
    return Number(match[1]);
  }
}

export function getActiveTourNumber(): number | undefined {
  return getTourNumber(store.activeTour!.review);
}

function getStepMarkerPrefix(tour: Review): string | undefined {
  if (tour.stepMarker) {
    return tour.stepMarker;
  } else {
    const tourNumber = getTourNumber(tour);
    if (tourNumber) {
      return `CT${tourNumber}`;
    }
  }
}

function getActiveStepMarkerPrefix(): string | undefined {
  return getStepMarkerPrefix(store.activeTour!.review);
}

export function getActiveStepMarker(): string | undefined {
  if (!isMarkerStep(store.activeTour!.review, store.activeTour!.step)) {
    return;
  }

  const prefix = getActiveStepMarkerPrefix();
  const suffix = `.${store.activeTour!.step + 1}`;
  return `${prefix}${suffix}`;
}

export async function getStepMarkerForLine(uri: Uri, lineNumber: number) {
  const document = await workspace.openTextDocument(uri);
  const line = document.lineAt(lineNumber).text;

  const stepMarkerPrefix = getActiveStepMarkerPrefix();
  const match = line.match(new RegExp(`${stepMarkerPrefix}.(\\d+)`));
  if (match) {
    return Number(match[1]);
  }
}

function isMarkerTour(tour: Review): boolean {
  return !!getStepMarkerPrefix(tour);
}

function isMarkerStep(tour: Review, stepNumber: number) {
  const step = tour.comments[stepNumber];
  return getStepMarkerPrefix(tour) && step.file && !step.line;
}

async function updateMarkerTitleForStep(tour: Review, stepNumber: number) {
  if (!isMarkerStep(tour, stepNumber)) {
    return;
  }

  const uri = await getStepFileUri(
    tour.comments[stepNumber],
    getWorkspaceUri(tour),
    tour.ref
  );

  const document = await workspace.openTextDocument(uri);
  const stepMarkerPrefix = getStepMarkerPrefix(tour);

  const markerPattern = new RegExp(
    `${stepMarkerPrefix}\\.${stepNumber + 1}\\s*[-:]\\s*(.*)`
  );

  const match = document.getText().match(markerPattern);
  if (match) {
    tour.comments[stepNumber].markerTitle = match[1];
  }
}

async function updateMarkerTitlesForTour(tour: Review) {
  if (!isMarkerTour(tour)) {
    return;
  }

  tour.comments.forEach((_, index) => updateMarkerTitleForStep(tour, index));
}

export async function updateMarkerTitles() {
  store.tours.forEach(updateMarkerTitlesForTour);
}
