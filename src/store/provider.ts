// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { comparer, runInAction, set } from "mobx";
import * as vscode from "vscode";
import { store, Vouch } from ".";
import { EXTENSION_NAME, VSCODE_DIRECTORY } from "../constants";
import { appendUriPath, readUriContents, updateMarkerTitles } from "../utils";
import { endCurrentCodeTour } from "./actions";

const MAIN_TOUR_FILES = [".tour", `${VSCODE_DIRECTORY}/main.tour`];
const SUB_TOUR_DIRECTORIES = [`${VSCODE_DIRECTORY}/tours`, `.vouch_reviews`];

const HAS_TOURS_KEY = `${EXTENSION_NAME}:hasTours`;

export async function discoverTours(): Promise<void> {
  const tours = await Promise.all(
    vscode.workspace.workspaceFolders!.map(async workspaceFolder => {
      const mainTours = await discoverMainTours(workspaceFolder.uri);
      const tours = await discoverSubTours(workspaceFolder.uri);

      if (mainTours) {
        tours.push(...mainTours);
      }

      return tours;
    })
  );

  runInAction(() => {
    store.tours = tours.flat().sort((a, b) => a.title.localeCompare(b.title));

    if (store.activeTour) {
      const tour = store.tours.find(
        tour => tour.id === store.activeTour!.tour.id
      );

      if (tour) {
        if (!comparer.structural(store.activeTour.tour, tour)) {
          // Since the active tour could be already observed,
          // we want to update it in place with the new properties.
          set(store.activeTour.tour, tour);
        }
      } else {
        // The user deleted the tour
        // file that's associated with
        // the active tour, so end it
        endCurrentCodeTour();
      }
    }
  });

  vscode.commands.executeCommand("setContext", HAS_TOURS_KEY, store.hasTours);
}

async function discoverMainTours(
  workspaceUri: vscode.Uri
): Promise<Vouch[]> {
  const tours = await Promise.all(
    MAIN_TOUR_FILES.map(async tourFile => {
      try {
        const uri = appendUriPath(workspaceUri, tourFile);

        const mainTourContent = await readUriContents(uri);
        const tour = JSON.parse(mainTourContent);
        tour.id = decodeURIComponent(uri.toString());
        return tour;
      } catch { }
    })
  );

  return tours.filter(tour => tour);
}

async function readTourDirectory(uri: vscode.Uri): Promise<Vouch[]> {
  try {
    const tourFiles = await vscode.workspace.fs.readDirectory(uri);
    const tours = await Promise.all(
      tourFiles.map(async ([file, type]) => {
        const fileUri = appendUriPath(uri, file);
        if (type === vscode.FileType.File) {
          return readTourFile(fileUri);
        } else {
          return readTourDirectory(fileUri);
        }
      })
    );

    // @ts-ignore
    return tours.flat().filter(tour => tour);
  } catch {
    return [];
  }
}

async function readTourFile(
  tourUri: vscode.Uri
): Promise<Vouch | undefined> {
  try {
    const tourContent = await readUriContents(tourUri);
    const tour = JSON.parse(tourContent);
    tour.id = decodeURIComponent(tourUri.toString());
    return tour;
  } catch { }
}

async function discoverSubTours(workspaceUri: vscode.Uri): Promise<Vouch[]> {
  const tours = await Promise.all(
    SUB_TOUR_DIRECTORIES.map(directory => {
      const uri = appendUriPath(workspaceUri, directory);
      return readTourDirectory(uri);
    })
  );

  return tours.flat();
}

async function discoverToursAndUpdateTitles() {
  await discoverTours();
  updateMarkerTitles();
}

vscode.workspace.onDidChangeWorkspaceFolders(discoverToursAndUpdateTitles);

const watcher = vscode.workspace.createFileSystemWatcher(
  "**/{.vscode/tours,.vouch_reviews}/**/*.{json,tour}"
);

watcher.onDidChange(discoverToursAndUpdateTitles);
watcher.onDidCreate(discoverToursAndUpdateTitles);
watcher.onDidDelete(discoverToursAndUpdateTitles);
