const moment = require('moment')
const bluebird = require('bluebird')
const cheerio = require('cheerio')
const { log } = require('cozy-konnector-libs')

module.exports = function parseRedMobileBills($) {
  const result = []
  moment.locale('fr')
  const baseURL = 'https://espace-client-red.sfr.fr'

  const firstBill = $($('.sr-container-main > .sr-container-wrapper-m').get(0))
  const firstBillUrl = $('#lien-telecharger-pdf').attr('href')

  if (firstBillUrl) {
    // The year is not provided, but we assume this is the current year or that
    // it will be provided if different from the current year
    let firstBillDate = firstBill
      .find('.sr-container-content span > span')
      .get(0)
    firstBillDate = $(firstBillDate)
      .text()
      .trim()
    firstBillDate = moment(firstBillDate, 'D MMM YYYY')
    const price = firstBill
      .find('.sr-text-25B')
      .text()
      .replace('€', '')
      .replace(',', '.')

    const bill = {
      date: firstBillDate.toDate(),
      amount: parseFloat(price),
      fileurl: `${baseURL}${firstBillUrl}`,
      filename: getFileName(firstBillDate),
      vendor: 'SFR RED MOBILE'
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
      return bluebird.mapSeries(trs, tr => {
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
            fileurl: `${baseURL}${fileurl}`,
            filename: getFileName(date),
            vendor: 'SFR RED MOBILE'
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

function getFileName(date) {
  return `${date.format('YYYY_MM')}_SfrRed.pdf`
}
