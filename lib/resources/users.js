// Copyright 2017 ODK Central Developers
// See the NOTICE file at the top-level directory of this distribution and at
// https://github.com/opendatakit/central-backend/blob/master/NOTICE.
// This file is part of ODK Central. It is subject to the license terms in
// the LICENSE file found in the top-level directory of this distribution and at
// https://www.apache.org/licenses/LICENSE-2.0. No part of ODK Central,
// including this file, may be copied, modified, propagated, or distributed
// except according to the terms contained in the LICENSE file.

const { always } = require('ramda');
const { success, isTrue } = require('../util/http');
const Option = require('../util/option');
const Problem = require('../util/problem');
const { resolve, reject, getOrNotFound } = require('../util/promise');
const { isPresent } = require('../util/util');

module.exports = (service, endpoint) => {

  // Get a list of user accounts.
  // TODO: paging.
  service.get('/users', endpoint(({ User }, { auth, query, queryOptions }) =>
    ((!auth.isAuthenticated())
      ? Problem.user.insufficientRights()
      : Promise.all([
        isPresent(query.q) ? User.getByEmail(query.q) : Option.none(),
        auth.can('user.list', User.species())
          .then((can) => can
            ? User.getAll(queryOptions.allowArgs('q')).then(Option.of)
            : Option.none())
      ])
        .then(([ exact, list ]) => exact.map((x) => [ x ]).orElse(list.orElse([]))))));

  service.post('/users', endpoint(({ User, mail, Audit }, { body, auth }) =>
    auth.canOrReject('user.create', User.species())
      .then(() => User.fromApi(body)
        .with({ actor: { type: 'user' } })
        // here we manually reincorporate the given password as it's allowed to
        // be set upon user creation (but not update).
        .withHashedPassword(body.password))
      .then((user) => user.forV1OnlyCopyEmailToDisplayName())
      .then((userData) => userData.create()
        .then((user) => Promise.all([
          user.provisionPasswordResetToken()
            .then((token) => mail(user.email, 'accountCreated', { token })),
          Audit.log(auth.actor(), 'user.create', user.actor, { data: userData })
        ])
          .then(always(user))))));

  // TODO/SECURITY: subtle timing attack here.
  service.post('/users/reset/initiate', endpoint(({ User, mail }, { auth, body, query }) =>
    User.getByEmail(body.email)
      .then((maybeUser) => maybeUser
        .map((user) => ((isTrue(query.invalidate))
          ? auth.canOrReject('user.password.invalidate', user.actor)
            .then(() => user.invalidatePassword())
          : resolve(user))
          .then(() => user.provisionPasswordResetToken()
              .then((token) => auth.can('user.password.invalidate', user.actor).then(can => can && `/#/account/claim?token=${token}`))))
        .orElseGet(() => User.emailEverExisted(body.email)
          .then((existed) => ((existed === true)
            ? mail(body.email, 'accountResetDeleted')
            : mail(body.email, 'accountResetFailure'))))
          .then((resetUrl) => ({success: true, resetUrl})))));

  // TODO: some standard URL structure for RPC-style methods.
  service.post('/users/reset/verify', endpoint(({ User }, { body, auth }) =>
    resolve(auth.actor())
      .then(getOrNotFound)
      .then((actor) => (((actor.meta == null) || (actor.meta.resetPassword == null))
        ? reject(Problem.user.insufficientRights())
        : User.getByActorId(actor.meta.resetPassword)
          .then(getOrNotFound)
          .then((user) => auth.canOrReject('user.password.reset', user.actor)
            .then(() => user.updatePassword(body.new))
            .then(() => actor.consume())
            .then(success))))));

  // Returns the currently authed actor.
  service.get('/users/current', endpoint(({ Actee, User }, { auth, queryOptions }) =>
    auth.actor().map((actor) =>
      ((queryOptions.extended === true)
        ? Promise.all([ User.getByActorId(actor.id).then(getOrNotFound), actor.verbsOn(Actee.all()) ])
          .then(([ user, verbs ]) => Object.assign({ verbs }, user.forApi()))
        : User.getByActorId(actor.id).then(getOrNotFound)))
      .orElse(Problem.user.notFound())));

  // Gets full details of a user by actor id.
  // TODO: infosec debate around 404 vs 403 if insufficient privs but record DNE.
  // TODO: once we have non-admins, probably hide email addresses unless admin/self?
  service.get('/users/:id', endpoint(({ User }, { auth, params }) =>
    User.getByActorId(params.id)
      .then(getOrNotFound)
      .then((user) => auth.canOrReject('user.read', user.actor)
        .then(() => user))));

  // TODO: infosec debate around 404 vs 403 if insufficient privs but record DNE.
  service.patch('/users/:id', endpoint(({ User, mail, Audit }, { params, body, auth }) =>
    User.getByActorId(params.id)
      .then(getOrNotFound)
      .then((user) => auth.canOrReject('user.update', user.actor)
        .then(() => User.fromApi(body))
        .then((patchData) => user.with(patchData).update()
          .then((result) => Promise.all([
            ((isPresent(patchData.email) && (patchData.email !== user.email))
              ? mail(user.email, 'accountEmailChanged', { oldEmail: user.email, newEmail: patchData.email })
              : resolve()),
            Audit.log(auth.actor(), 'user.update', user.actor, { data: patchData })
          ])
            .then(always(result)))))));

  // TODO: ditto infosec debate.
  // TODO: exact endpoint naming.
  service.put('/users/:id/password', endpoint(({ Audit, User, mail, crypto }, { params, body, auth }) =>
    User.getByActorId(params.id)
      .then(getOrNotFound)
      .then((user) => auth.canOrReject('user.update', user.actor)
        .then(() => crypto.verifyPassword(body.old, user.password)
          .then((verified) => ((verified === true)
            ? Promise.all([
              user.updatePassword(body.new)
                .then(() => mail(user.email, 'accountPasswordChanged')),
              Audit.log(auth.actor(), 'user.update', user.actor, { data: { password: true } })
            ]).then(success)
            : Problem.user.authenticationFailed()))))));

  service.delete('/users/:id', endpoint(({ User, Assignment, Audit, Session }, { params, auth }) =>
    User.getByActorId(params.id)
      .then(getOrNotFound)
      .then((user) => auth.canOrReject('user.delete', user.actor)
        .then(() => Promise.all([
          user.delete(),
          Assignment.deleteByActor(user.actor),
          Session.deleteByActor(user.actor),
          Audit.log(auth.actor(), 'user.delete', user.actor)
        ]))
        .then(success))));
};

