import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import { Permission } from "../../src/permissions/Permission.js";
import {
  ApprovalController,
} from "../../src/permissions/ApprovalController.js";


describe(
  "ApprovalController",
  () => {
    const controllers: ApprovalController[] = [];


    afterEach(() => {
      controllers.length = 0;
    });


    it(
      "creates a pending approval request",
      () => {
        const controller =
          new ApprovalController(
            60_000
          );

        controllers.push(controller);


        const promise =
          controller.request({
            permission:
              Permission.WRITE_FILE,
            reason:
              "Test write operation.",
            target:
              "test.txt",
          });


        expect(
          controller.getPending()
        ).toHaveLength(1);


        expect(
          controller.getPending()[0]
        ).toMatchObject({
          permission:
            Permission.WRITE_FILE,
          reason:
            "Test write operation.",
          target:
            "test.txt",
        });


        void promise;
      }
    );


    it(
      "resolves true when approved",
      async () => {
        const controller =
          new ApprovalController(
            60_000
          );

        controllers.push(controller);


        const promise =
          controller.request({
            permission:
              Permission.WRITE_FILE,
            reason:
              "Approve test.",
          });


        const pending =
          controller.getPending();


        expect(
          pending
        ).toHaveLength(1);


        const id =
          pending[0]!.id;


        expect(
          controller.approve(id)
        ).toBe(true);


        await expect(
          promise
        ).resolves.toBe(true);


        expect(
          controller.getPending()
        ).toHaveLength(0);
      }
    );


    it(
      "resolves false when denied",
      async () => {
        const controller =
          new ApprovalController(
            60_000
          );

        controllers.push(controller);


        const promise =
          controller.request({
            permission:
              Permission.DELETE_FILE,
            reason:
              "Delete test.",
          });


        const id =
          controller.getPending()[0]!.id;


        expect(
          controller.deny(id)
        ).toBe(true);


        await expect(
          promise
        ).resolves.toBe(false);


        expect(
          controller.getPending()
        ).toHaveLength(0);
      }
    );


    it(
      "rejects unknown approval IDs",
      () => {
        const controller =
          new ApprovalController(
            60_000
          );

        controllers.push(controller);


        expect(
          controller.approve(
            "unknown-id"
          )
        ).toBe(false);


        expect(
          controller.deny(
            "unknown-id"
          )
        ).toBe(false);
      }
    );


    it(
      "cannot approve the same request twice",
      async () => {
        const controller =
          new ApprovalController(
            60_000
          );

        controllers.push(controller);


        const promise =
          controller.request({
            permission:
              Permission.RUN_COMMAND,
            reason:
              "Command test.",
          });


        const id =
          controller.getPending()[0]!.id;


        expect(
          controller.approve(id)
        ).toBe(true);


        expect(
          controller.approve(id)
        ).toBe(false);


        expect(
          controller.deny(id)
        ).toBe(false);


        await expect(
          promise
        ).resolves.toBe(true);
      }
    );


    it(
      "automatically denies an expired approval",
      async () => {
        const controller =
          new ApprovalController(
            20
          );

        controllers.push(controller);


        const promise =
          controller.request({
            permission:
              Permission.WRITE_FILE,
            reason:
              "Timeout test.",
          });


        await expect(
          promise
        ).resolves.toBe(false);


        expect(
          controller.getPending()
        ).toHaveLength(0);
      }
    );


    it(
      "rejects an invalid timeout",
      () => {
        expect(
          () =>
            new ApprovalController(
              0
            )
        ).toThrow(
          "Approval timeout must be a positive integer."
        );


        expect(
          () =>
            new ApprovalController(
              -1
            )
        ).toThrow(
          "Approval timeout must be a positive integer."
        );


        expect(
          () =>
            new ApprovalController(
              1.5
            )
        ).toThrow(
          "Approval timeout must be a positive integer."
        );
      }
    );
  }
);