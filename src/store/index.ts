// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { observable } from "mobx";
import { CommentThread, Uri } from "vscode";

export interface CodeTourStepPosition {
  line: number;
  character: number;
}

export interface CodeTourStep {
  title?: string;
  description: string;

  // If any of the following are set, then only
  // one of them can be, since these properties
  // indicate the "type" of step.
  file?: string;
  directory?: string;
  contents?: string;
  uri?: string;
  view?: string;

  // A line number and selection is only relevant for file-based
  // steps. And even then, they're optional. If a file-based step
  // doesn't have a line number, then the description is attached
  // to the last line in the file, assuming it's describing the file itself
  line?: number;
  selection?: { start: CodeTourStepPosition; end: CodeTourStepPosition };

  commands?: string[];

  pattern?: string;
  markerTitle?: string;
}

export interface Review {
  id: string;
  title: string;
  description?: string;
  comments: CodeTourStep[];
  ref?: string;
  isPrimary?: boolean;
  nextTour?: string;
  stepMarker?: string;
}

export interface ActiveTour {
  review: Review;
  step: number;

  // When recording, a tour can be active, without
  // having created an actual comment yet.
  thread: CommentThread | null | undefined;

  // In order to resolve relative file
  // paths, we need to know the workspace root
  workspaceRoot?: Uri;

  // In order to resolve inter-tour
  // links, the active tour might need
  // the context of its sibling tours, if
  // they're coming from somewhere other
  // then the active workspace (e.g. a
  // GistPad-managed repo).
  tours?: Review[];
}

type CodeTourProgress = [string, number[]];

export interface Store {
  tours: Review[];
  activeTour: ActiveTour | null;
  hasTours: boolean;
  isRecording: boolean;
  showMarkers: boolean;
  progress: CodeTourProgress[];
}

export const store: Store = observable({
  tours: [],
  activeTour: null,
  isRecording: false,
  get hasTours() {
    return this.tours.length > 0;
  },
  showMarkers: false,
  progress: []
});
