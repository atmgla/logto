import { emailRegEx, passwordRegEx, phoneRegEx, usernameRegEx } from '@logto/core-kit';
import { arbitraryObjectGuard, userInfoSelectFields } from '@logto/schemas';
import { has, pick } from '@silverhand/essentials';
import { argon2Verify } from 'hash-wasm';
import { object, string, unknown } from 'zod';

import { getLogtoConnectorById } from '#src/connectors/index.js';
import RequestError from '#src/errors/RequestError/index.js';
import { checkSessionHealth } from '#src/libraries/session.js';
import { getUserInfoByAuthCode } from '#src/libraries/social.js';
import { encryptUserPassword } from '#src/libraries/user.js';
import koaGuard from '#src/middleware/koa-guard.js';
import assertThat from '#src/utils/assert-that.js';

import { verificationTimeout } from './consts.js';
import type { AnonymousRouter, RouterInitArgs } from './types.js';

export const profileRoute = '/profile';

export default function profileRoutes<T extends AnonymousRouter>(
  ...[router, tenant]: RouterInitArgs<T>
) {
  const { provider, libraries, queries } = tenant;
  const { deleteUserIdentity, findUserById, updateUserById } = queries.users;
  const {
    users: { checkIdentifierCollision },
  } = libraries;

  router.get(profileRoute, async (ctx, next) => {
    const { accountId: userId } = await provider.Session.get(ctx);

    assertThat(userId, new RequestError({ code: 'auth.unauthorized', status: 401 }));

    const user = await findUserById(userId);

    ctx.body = {
      ...pick(user, ...userInfoSelectFields),
      hasPasswordSet: Boolean(user.passwordEncrypted),
    };

    ctx.status = 200;

    return next();
  });

  router.patch(
    profileRoute,
    koaGuard({
      body: object({
        name: string().nullable().optional(),
        avatar: string().nullable().optional(),
        customData: arbitraryObjectGuard.optional(),
      }),
    }),
    async (ctx, next) => {
      const { accountId: userId } = await provider.Session.get(ctx);

      assertThat(userId, new RequestError({ code: 'auth.unauthorized', status: 401 }));

      const { name, avatar, customData } = ctx.guard.body;

      await updateUserById(userId, { name, avatar, customData });

      ctx.status = 204;

      return next();
    }
  );

  router.patch(
    `${profileRoute}/username`,
    koaGuard({
      body: object({ username: string().regex(usernameRegEx) }),
    }),
    async (ctx, next) => {
      console.log('?0');
      const userId = await checkSessionHealth(ctx, tenant, verificationTimeout);
      assertThat(userId, new RequestError({ code: 'auth.unauthorized', status: 401 }));

      const { username } = ctx.guard.body;
      console.log('?1');
      await checkIdentifierCollision({ username }, userId);
      console.log('?2');
      await updateUserById(userId, { username }, 'replace');

      ctx.status = 204;

      return next();
    }
  );

  router.patch(
    `${profileRoute}/password`,
    koaGuard({
      body: object({ password: string().regex(passwordRegEx) }),
    }),
    async (ctx, next) => {
      const userId = await checkSessionHealth(ctx, tenant, verificationTimeout);

      assertThat(userId, new RequestError({ code: 'auth.unauthorized', status: 401 }));

      const { password } = ctx.guard.body;
      const { passwordEncrypted: oldPasswordEncrypted } = await findUserById(userId);

      assertThat(
        !oldPasswordEncrypted || !(await argon2Verify({ password, hash: oldPasswordEncrypted })),
        new RequestError({ code: 'user.same_password', status: 422 })
      );

      const { passwordEncrypted, passwordEncryptionMethod } = await encryptUserPassword(password);

      await updateUserById(userId, { passwordEncrypted, passwordEncryptionMethod });

      ctx.status = 204;

      return next();
    }
  );

  router.patch(
    `${profileRoute}/email`,
    koaGuard({
      body: object({ primaryEmail: string().regex(emailRegEx) }),
    }),
    async (ctx, next) => {
      const userId = await checkSessionHealth(ctx, tenant, verificationTimeout);

      assertThat(userId, new RequestError({ code: 'auth.unauthorized', status: 401 }));

      const { primaryEmail } = ctx.guard.body;

      await checkIdentifierCollision({ primaryEmail });
      await updateUserById(userId, { primaryEmail });

      ctx.status = 204;

      return next();
    }
  );

  router.delete(`${profileRoute}/email`, async (ctx, next) => {
    const userId = await checkSessionHealth(ctx, tenant, verificationTimeout);

    assertThat(userId, new RequestError({ code: 'auth.unauthorized', status: 401 }));

    const { primaryEmail } = await findUserById(userId);

    assertThat(primaryEmail, new RequestError({ code: 'user.email_not_exist', status: 422 }));

    await updateUserById(userId, { primaryEmail: null });

    ctx.status = 204;

    return next();
  });

  router.patch(
    `${profileRoute}/phone`,
    koaGuard({
      body: object({ primaryPhone: string().regex(phoneRegEx) }),
    }),
    async (ctx, next) => {
      const userId = await checkSessionHealth(ctx, tenant, verificationTimeout);

      assertThat(userId, new RequestError({ code: 'auth.unauthorized', status: 401 }));

      const { primaryPhone } = ctx.guard.body;

      await checkIdentifierCollision({ primaryPhone });
      await updateUserById(userId, { primaryPhone });

      ctx.status = 204;

      return next();
    }
  );

  router.delete(`${profileRoute}/phone`, async (ctx, next) => {
    const userId = await checkSessionHealth(ctx, tenant, verificationTimeout);

    assertThat(userId, new RequestError({ code: 'auth.unauthorized', status: 401 }));

    const { primaryPhone } = await findUserById(userId);

    assertThat(primaryPhone, new RequestError({ code: 'user.phone_not_exist', status: 422 }));

    await updateUserById(userId, { primaryPhone: null });

    ctx.status = 204;

    return next();
  });

  router.patch(
    `${profileRoute}/identities`,
    koaGuard({
      body: object({
        connectorId: string(),
        data: unknown(),
      }),
    }),
    async (ctx, next) => {
      const userId = await checkSessionHealth(ctx, tenant, verificationTimeout);

      assertThat(userId, new RequestError({ code: 'auth.unauthorized', status: 401 }));

      const { connectorId, data } = ctx.guard.body;

      const {
        metadata: { target },
      } = await getLogtoConnectorById(connectorId);

      const socialUserInfo = await getUserInfoByAuthCode(connectorId, data);
      const { identities } = await findUserById(userId);

      await updateUserById(userId, {
        identities: {
          ...identities,
          [target]: { userId: socialUserInfo.id, details: socialUserInfo },
        },
      });

      ctx.status = 204;

      return next();
    }
  );

  router.delete(
    `${profileRoute}/identities/:target`,
    koaGuard({
      params: object({ target: string() }),
    }),
    async (ctx, next) => {
      const { accountId: userId } = await provider.Session.get(ctx);

      assertThat(userId, new RequestError({ code: 'auth.unauthorized', status: 401 }));

      const { target } = ctx.guard.params;
      const { identities } = await findUserById(userId);

      assertThat(
        has(identities, target),
        new RequestError({ code: 'user.identity_not_exist', status: 404 })
      );

      await deleteUserIdentity(userId, target);

      ctx.status = 204;

      return next();
    }
  );
}
