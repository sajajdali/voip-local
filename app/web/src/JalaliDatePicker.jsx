// Port of the design's JalaliDatePicker component (design/datepicker.template.html).
import React from 'react';
import DatePickerView from './generated/DatePickerView.jsx';
import { TODAY, MONTHS, pad, monthLen, weekdayOf, faNum } from './jalali.js';

const WD = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];

export default class JalaliDatePicker extends React.Component {
  state = { open: false, vy: null, vm: null };
  ref = React.createRef();
  componentDidMount() { this.h = e => { if (this.state.open && this.ref.current && !this.ref.current.contains(e.target)) this.setState({ open: false }); }; document.addEventListener('mousedown', this.h); }
  componentWillUnmount() { document.removeEventListener('mousedown', this.h); }
  emit(v) { this.props.onChange && this.props.onChange(v); this.setState({ open: false }); }
  renderVals() {
    const v = this.props.value || ''; const base = (v || TODAY).split('/').map(Number);
    const y = this.state.vy ?? base[0], m = this.state.vm ?? base[1];
    const rs = this.props.rangeStart, re = this.props.rangeEnd;
    const first = weekdayOf(y, m, 1), n = monthLen(y, m), cells = [];
    for (let i = 0; i < first; i++) cells.push({ d: '', bg: 'transparent', fg: '#232425', bd: 'transparent', fw: 500, cur: 'default', pick: () => {} });
    for (let d = 1; d <= n; d++) {
      const key = y + '/' + pad(m) + '/' + pad(d), sel = key === v, inR = rs && re && key >= rs && key <= re, col = (first + d - 1) % 7;
      cells.push({ d, bg: sel ? '#8DC63F' : inR ? '#eef5e3' : 'transparent', fg: sel ? '#1f2021' : col === 6 ? '#b42318' : '#232425', bd: key === TODAY && !sel ? '#8DC63F' : 'transparent', fw: sel || key === TODAY ? 800 : 500, cur: 'pointer', pick: () => this.emit(key) });
    }
    const go = dlt => () => { let mm = m + dlt, yy = y; if (mm < 1) { mm = 12; yy--; } if (mm > 12) { mm = 1; yy++; } this.setState({ vy: yy, vm: mm }); };
    const label = this.props.label || '';
    const t = TODAY.split('/');
    return {
      ref: this.ref, label, hasLabel: !!label, open: this.state.open,
      text: v ? v.split('/')[2].replace(/^0/, '') + ' ' + MONTHS[+v.split('/')[1] - 1] + ' ' + v.split('/')[0] : (this.props.placeholder || 'انتخاب تاریخ'),
      textFg: v ? '#232425' : '#8b8e89', trigBd: this.state.open ? '#8DC63F' : '#e1e3dc',
      toggle: () => this.setState({ open: !this.state.open, vy: base[0], vm: base[1] }),
      monthName: MONTHS[m - 1], year: y, prev: go(-1), next: go(1), cells,
      weekdays: WD.map((l, i) => ({ l, fg: i === 6 ? '#b42318' : '#6b6e72' })),
      pickToday: () => this.emit(TODAY), clearable: !!this.props.clearable, clear: () => this.emit(''),
      todayText: 'امروز: ' + faNum(+t[2]) + ' ' + MONTHS[+t[1] - 1] + ' ' + faNum(t[0]),
    };
  }
  render() {
    const el = <DatePickerView vm={this.renderVals()} />;
    return this.props.style ? <div style={this.props.style}>{el}</div> : el;
  }
}
