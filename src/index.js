process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://896462846d0e40d0b1522d98ab103133@sentry.cozycloud.cc/118'

const {
  CookieKonnector,
  errors,
  log,
  solveCaptcha,
  retry,
  mkdirp,
  utils
} = require('cozy-konnector-libs')
const moment = require('moment')
const bluebird = require('bluebird')
const cheerio = require('cheerio')
const DEBUG = false

class SfrConnector extends CookieKonnector {
  async fetch(fields) {
    if (!(await this.testSession())) {
      await this.testLogin(fields)
      const { form, $ } = await retry(this.getForm, {
        interval: 5000,
        throw_original: true,
        context: this
      })

      await this.logIn(form, fields, $)
    }

    // // trying to change contract
    // this.request = this.requestFactory({
    //   cheerio: false,
    //   json: false,
    //   debug: DEBUG,
    //   headers: {}
    // })
    // const rmehcookie = this._jar
    //   .getCookies('https://sfr.fr/')
    //   .find(cookie => cookie.key === 'rmeh').value
    // const body = await this.request(
    //   `https://www.sfr.fr/fragments/profile-stats.js?u=${rmehcookie}#`
    // )

    // const contracts = JSON.parse(
    //   body.match(/_.LL=(\[.*\]);/)[1].replace(/'/g, '"')
    // )
    // console.log(contracts)

    // console.log(contracts[1].split(':'))
    // const code = contracts[1].split(':')[2]
    // console.log(code, 'code')

    // await this.request(`https://www.red-by-sfr.fr/eTagP/ck.jsp?MLS~${code}~99`)

    // this.request = this.requestFactory({
    //   cheerio: true,
    //   json: false,
    //   debug: DEBUG,
    //   headers: {}
    // })

    // this._jar.setCookie(
    //   this.request.cookie(`MLS=${code}`),
    //   'https://www.sfr.fr/'
    // )
    // console.log(this._jar)
    // const $ = await this.request(
    //   `https://www.sfr.fr/mon-espace-client/?e=${code}#sfrclicid=EC_Home_Selecteur`
    // )

    // get current contract
    const $ = await this.request('https://www.sfr.fr/mon-espace-client/')
    this.currentContract = $('#eTtN > div#L')
      .text()
      .trim()
      .split(' ')
      .join('')

    if (this.currentContract.includes('RÉSILIÉE')) {
      log('warn', `Found a terminated contract`)
      log('info', this.currentContract)
      return
    }

    const folderPath = `${fields.folderPath}/${this.currentContract}`
    await mkdirp(folderPath)

    const entries = (await retry(this.fetchBillsAttempts, {
      interval: 5000,
      throw_original: true,
      // do not retry if we get the LOGIN_FAILED error code
      predicate: err => err.message !== 'LOGIN_FAILED',
      context: this
    })).map(doc => ({
      ...doc,
      vendor: 'SFR',
      currency: '€',
      contract: this.currentContract,
      filename: `${utils.formatDate(doc.date)}_SFR_${doc.amount.toFixed(
        2
      )}€.pdf`,
      metadata: {
        importDate: new Date(),
        version: 1
      }
    }))

    return this.saveBills(entries, folderPath, {
      identifiers: ['sfr']
    })
  }

  async testLogin(fields) {
    this.requestJson = this.requestFactory({
      cheerio: false,
      json: true,
      debug: DEBUG
    })
    let token
    try {
      let { createToken } = await this.requestJson(
        'https://www.sfr.fr/cas/services/rest/1.0/createToken.json?duration=8640',
        {
          auth: {
            user: fields.login,
            password: fields.password
          }
        }
      )
      token = createToken.token
    } catch (err) {
      log('error', err.message)
      throw new Error(errors.LOGIN_FAILED)
    }

    const compte = await this.requestJson(
      'https://www.sfr.fr/webservices/userprofile/rest/moncompte/' + Date.now(),
      {
        headers: {
          casauthenticationtoken: token
        }
      }
    )

    this.sfrAccount = compte.ficheMonCompte
  }

  async logIn(form, fields, $) {
    const submitForm = {
      ...form,
      username: fields.login,
      password: fields.password,
      'remember-me': 'on'
    }

    if ($('.g-recaptcha').length) {
      submitForm['g-recaptcha-response'] = await solveCaptcha({
        websiteKey: $('.g-recaptcha').data('sitekey'),
        websiteURL: 'https://www.sfr.fr/cas/login'
      })
    }

    const login$ = await this.request({
      method: 'POST',
      url:
        'https://www.sfr.fr/cas/login?domain=mire-sfr&service=https%3A%2F%2Fwww.sfr.fr%2Fj_spring_cas_security_check#sfrclicid=EC_mire_Me-Connecter',
      form: submitForm
    })

    if (login$('#loginForm').length) {
      log('error', 'html form login failed after success in api login')
      throw new Error(errors.VENDOR_DOWN)
    }
  }

  async testSession() {
    const $ = await this.request('https://www.sfr.fr/routage/consulter-facture')
    return $('#loginForm').length === 0
  }

  async getForm() {
    log('info', 'Logging in on Sfr Website...')
    const $ = await this.request('https://www.sfr.fr/cas/login')

    return { form: getFormData($('#loginForm')), $ }
  }

  fetchBillsAttempts() {
    return fetchBillingInfo
      .bind(this)()
      .then($ => {
        if (this.contractType === 'mobile') {
          return parseMobileBills.bind(this)($)
        } else if (this.contractType === 'fixe') {
          return parseFixeBills.bind(this)($)
        }
      })
  }
}

const connector = new SfrConnector({
  cheerio: true,
  json: false,
  debug: DEBUG,
  headers: {}
})

connector.run()

function getFormData($form) {
  return $form
    .serializeArray()
    .reduce((memo, input) => ({ ...memo, [input.name]: input.value }), {})
}

function fetchBillingInfo() {
  log('info', 'Fetching bill info')
  return this.request({
    url: 'https://www.sfr.fr/routage/consulter-facture',
    resolveWithFullResponse: true
  }).then(response => {
    // check that the page was not redirected to another sfr service
    const finalPath = response.request.uri.path
    log('info', finalPath, 'finalPath after fetch billing info')
    if (finalPath === '/facture-mobile/consultation') {
      this.contractType = 'mobile'
    } else if (finalPath === '/facture-fixe/consultation') {
      this.contractType = 'fixe'
    } else {
      throw new Error('Unknown SFR contract type')
    }
    const finalHostname = response.request.uri.hostname
    log('info', finalHostname, 'finalHostname after fetch billing info')
    // sfr : espace-client.sfr.fr
    // red : ?
    // numericable : ?

    return response.body
  })
}

function parseFixeBills($) {
  const result = []
  moment.locale('fr')
  const baseURL = 'https://espace-client.sfr.fr'

  // handle the special case of the first bill
  const $firstBill = $('#lastFacture')
  const firstBillUrl = $firstBill.find('a.sr-chevron').attr('href')

  if (firstBillUrl) {
    const fields = $firstBill
      .find('.sr-container-content')
      .eq(0)
      .find('span')
    const firstBillDate = moment(
      fields
        .eq(1)
        .text()
        .trim(),
      'DD/MM/YYYY'
    )
    const price = fields
      .eq(2)
      .text()
      .trim()
      .replace('€', '')
      .replace(',', '.')

    const bill = {
      date: firstBillDate.toDate(),
      amount: parseFloat(price),
      fileurl: `${baseURL}${firstBillUrl}`
    }

    result.push(bill)
  } else {
    log('info', 'wrong url for first PDF bill.')
  }

  return bluebird
    .mapSeries(Array.from($('table.sr-multi-payment tbody tr')), tr => {
      let link = $(tr)
        .find('td')
        .eq(1)
        .find('a')
      if (link.length === 1) {
        link = baseURL + link.attr('href')
        return this.request(link).then($ =>
          $('.sr-container-wrapper-m')
            .eq(0)
            .html()
        )
      } else {
        return false
      }
    })
    .then(list => list.filter(item => item))
    .then(list =>
      list.map(item => {
        const $ = cheerio.load(item)
        const fileurl = $('a.sr-chevron').attr('href')
        const fields = $('.sr-container-box-M')
          .eq(0)
          .find('span')
        const date = moment(
          fields
            .eq(1)
            .text()
            .trim(),
          'DD/MM/YYYY'
        )
        const price = fields
          .eq(2)
          .text()
          .trim()
          .replace('€', '')
          .replace(',', '.')
        if (price) {
          const bill = {
            date: date.toDate(),
            amount: parseFloat(price),
            fileurl: `${baseURL}${fileurl}`
          }
          return bill
        } else return null
      })
    )
    .then(list => list.filter(item => item))
    .then(bills => {
      if (result.length) bills.unshift(result[0])
      return bills
    })
}

function parseMobileBills($) {
  const result = []
  moment.locale('fr')
  const baseURL = 'https://espace-client.sfr.fr'

  // handle the special case of the first bill
  const $firstBill = $('.sr-container-wrapper-m').eq(0)
  const firstBillUrl = $firstBill.find('#lien-telecharger-pdf').attr('href')

  if (firstBillUrl) {
    const fields = $firstBill
      .find('.sr-container-content')
      .eq(0)
      .find('span:not(.sr-text-grey-14)')
    const firstBillDate = moment(fields.eq(0).text(), 'DD MMMM YYYY')
    const price = fields
      .eq(1)
      .text()
      .replace('€', '')
      .replace(',', '.')

    const bill = {
      date: firstBillDate.toDate(),
      amount: parseFloat(price),
      fileurl: `${baseURL}${firstBillUrl}`
    }

    result.push(bill)
  } else {
    log('info', 'wrong url for first PDF bill.')
  }

  let trs = Array.from($('table.sr-multi-payment tbody tr'))

  function getMoreBills() {
    // find some more rows if any
    return this.request(`${baseURL}/facture-mobile/consultation/plusDeFactures`)
      .then($ => $('tr'))
      .then($trs => {
        if ($trs.length > trs.length) {
          trs = Array.from($trs)
          return getMoreBills.bind(this)()
        } else return Promise.resolve()
      })
  }

  return getMoreBills
    .bind(this)()
    .then(() => {
      return bluebird
        .mapSeries(trs, tr => {
          let link = $(tr)
            .find('td')
            .eq(1)
            .find('a')
          if (link.length === 1) {
            link = baseURL + link.attr('href')
            return this.request(link).then($ =>
              $('.sr-container-wrapper-m')
                .eq(0)
                .html()
            )
          } else {
            return false
          }
        })
        .then(list => list.filter(item => item))
        .then(list =>
          list.map(item => {
            const $ = cheerio.load(item)
            const fileurl = $('#lien-duplicata-pdf-').attr('href')
            const fields = $('.sr-container-content')
              .eq(0)
              .find('span:not(.sr-text-grey-14)')
            const date = moment(
              fields
                .eq(0)
                .text()
                .trim(),
              'DD MMMM YYYY'
            )
            const price = fields
              .eq(1)
              .text()
              .trim()
              .replace('€', '')
              .replace(',', '.')
            if (price) {
              const bill = {
                date: date.toDate(),
                amount: parseFloat(price),
                fileurl: `${baseURL}${fileurl}`
              }
              return bill
            } else return null
          })
        )
        .then(list => list.filter(item => item))
        .then(bills => {
          if (result.length) bills.unshift(result[0])
          return bills
        })
    })
}
