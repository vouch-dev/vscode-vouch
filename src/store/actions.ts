// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { commands, EventEmitter, Memento, Uri, window } from "vscode";
import { store, Review } from ".";
import { EXTENSION_NAME, FS_SCHEME, FS_SCHEME_CONTENT } from "../constants";
import { startPlayer, stopPlayer } from "../player";
import {
  getStepFileUri,
  getWorkspaceKey,
  getWorkspaceUri,
  readUriContents
} from "../utils";
import { progress } from "./storage";

const CAN_EDIT_TOUR_KEY = `${EXTENSION_NAME}:canEditTour`;
const IN_TOUR_KEY = `${EXTENSION_NAME}:inTour`;
const RECORDING_KEY = `${EXTENSION_NAME}:recording`;

const _onDidEndTour = new EventEmitter<Review>();
export const onDidEndTour = _onDidEndTour.event;

const _onDidStartTour = new EventEmitter<[Review, number]>();
export const onDidStartTour = _onDidStartTour.event;

export function startCodeTour(
  tour: Review,
  stepNumber?: number,
  workspaceRoot?: Uri,
  startInEditMode: boolean = false,
  canEditTour: boolean = true,
  tours?: Review[]
) {
  startPlayer();

  if (!workspaceRoot) {
    workspaceRoot = getWorkspaceUri(tour);
  }

  const step = stepNumber ? stepNumber : tour.comments.length ? 0 : -1;
  store.activeTour = {
    review: tour,
    step,
    workspaceRoot,
    thread: null,
    tours
  };

  commands.executeCommand("setContext", IN_TOUR_KEY, true);
  commands.executeCommand("setContext", CAN_EDIT_TOUR_KEY, canEditTour);

  if (startInEditMode) {
    store.isRecording = true;
    commands.executeCommand("setContext", RECORDING_KEY, true);
  } else {
    _onDidStartTour.fire([tour, step]);
  }
}

export async function selectTour(
  tours: Review[],
  workspaceRoot?: Uri
): Promise<boolean> {
  const items: any[] = tours.map(tour => ({
    label: tour.title!,
    tour: tour,
    detail: tour.description
  }));

  if (items.length === 1) {
    startCodeTour(items[0].tour, 0, workspaceRoot, false, true, tours);
    return true;
  }

  const response = await window.showQuickPick(items, {
    placeHolder: "Select the tour to start..."
  });

  if (response) {
    startCodeTour(response.tour, 0, workspaceRoot, false, true, tours);
    return true;
  }

  return false;
}

export async function endCurrentCodeTour(fireEvent: boolean = true) {
  if (fireEvent) {
    _onDidEndTour.fire(store.activeTour!.review);
  }

  if (store.isRecording) {
    store.isRecording = false;
    commands.executeCommand("setContext", RECORDING_KEY, false);
  }

  stopPlayer();

  store.activeTour = null;
  commands.executeCommand("setContext", IN_TOUR_KEY, false);

  window.visibleTextEditors.forEach(editor => {
    if (
      editor.document.uri.scheme === FS_SCHEME ||
      editor.document.uri.scheme === FS_SCHEME_CONTENT
    ) {
      editor.hide();
    }
  });
}

export function moveCurrentCodeTourBackward() {
  --store.activeTour!.step;

  _onDidStartTour.fire([store.activeTour!.review, store.activeTour!.step]);
}

export async function moveCurrentCodeTourForward() {
  await progress.update();

  store.activeTour!.step++;

  _onDidStartTour.fire([store.activeTour!.review, store.activeTour!.step]);
}

export async function exportTour(tour: Review) {
  const newTour = {
    ...tour
  };

  newTour.comments = await Promise.all(
    newTour.comments.map(async step => {
      if (step.contents || step.uri || !step.file) {
        return step;
      }

      const workspaceRoot = getWorkspaceUri(tour);
      const stepFileUri = await getStepFileUri(step, workspaceRoot, tour.ref);
      const contents = await readUriContents(stepFileUri);

      delete step.markerTitle;

      return {
        ...step,
        contents
      };
    })
  );

  delete newTour.id;
  delete newTour.ref;

  return JSON.stringify(newTour, null, 2);
}

export async function recordTour(workspaceRoot: Uri) {
  commands.executeCommand(`${EXTENSION_NAME}.recordTour`, workspaceRoot);
}
